import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";
import { Channel, MediaPath } from "./types";
import { now } from "./utils";

/**
 * 转推(relay)管理器 —— 把已在线的源流原样(-c copy,不转码)转推到每个渠道配置的
 * 目标 RTMP 地址(如 B 站 / 抖音 / YouTube)。
 *
 * 生命周期沿用 transcoder 的做法:失败指数退避重启、SIGTERM 后限时 SIGKILL、退出回调统一清理。
 * 与 transcoder 的不同点:输出目标是「每渠道各异且可随时修改」的外部地址,所以 sync 会记录每个
 * 运行进程当前的目标 URL,一旦渠道改了目标就先停旧进程,下一轮再用新目标起。
 *
 * 拉源用的是与 transcoder 相同的「内部读取者」凭证,server.ts 的 /internal/mediamtx/auth
 * (read/rtmp 分支)据此放行。
 */

const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 30000;
const FORCE_KILL_DELAY_MS = 5000;

type ManagedProcess = {
  child: ChildProcessWithoutNullStreams;
  targetUrl: string;
  stopping: boolean;
  ended: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
};

type BackoffState = {
  failures: number;
  nextAttempt: number;
};

type RelayOptions = {
  ffmpegBin: string;
  rtmpOrigin: string;
  readUser: string;
  readPass: string;
  logger: FastifyBaseLogger;
};

function buildInputUrl(origin: string, slug: string, user: string, pass: string): string {
  return `${origin}/${encodeURIComponent(slug)}?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`;
}

function buildRelayArgs(inputUrl: string, outputUrl: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts",
    "-rtmp_live",
    "live",
    "-i",
    inputUrl,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    // -c copy:直接转发 OBS 已编码的 H.264/AAC,不二次转码,几乎零 CPU 开销。
    "-c",
    "copy",
    "-f",
    "flv",
    outputUrl,
  ];
}

export class RelayManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly backoff = new Map<string, BackoffState>();

  constructor(private readonly options: RelayOptions) {}

  /** 某渠道当前是否正在转推(用于后台展示状态)。 */
  isRelaying(slug: string): boolean {
    const managed = this.processes.get(slug);
    return Boolean(managed && !managed.stopping);
  }

  sync(channels: Channel[], paths: MediaPath[]): void {
    const pathMap = new Map(paths.map((path) => [path.name, path]));

    // 期望在转推的渠道:已启用、配了目标地址、且源在线。
    const desired = new Map<string, string>();
    for (const channel of channels) {
      const relayUrl = channel.relayUrl.trim();
      const sourceOnline = pathMap.get(channel.slug)?.online ?? false;
      if (channel.enabled && relayUrl && sourceOnline) {
        desired.set(channel.slug, relayUrl);
      }
    }

    // 停掉:不再期望的,或目标地址已变化的(变化的进程停掉后下一轮用新目标重启)。
    for (const [slug, managed] of this.processes) {
      if (managed.stopping) {
        continue;
      }
      const wanted = desired.get(slug);
      if (wanted === undefined || wanted !== managed.targetUrl) {
        this.stop(slug);
      }
    }

    // 起新的:期望转推但当前没有进程、且不在退避冷却中的。
    for (const [slug, url] of desired) {
      if (this.processes.has(slug) || !this.canStart(slug)) {
        continue;
      }
      this.start(slug, url);
    }
  }

  stop(slug: string): void {
    const managed = this.processes.get(slug);
    if (!managed || managed.stopping) {
      return;
    }
    managed.stopping = true;
    this.backoff.delete(slug);
    this.options.logger.info({ slug }, "stopping relay");
    managed.child.kill("SIGTERM");
    managed.killTimer = setTimeout(() => {
      if (!managed.ended) {
        this.options.logger.warn({ slug }, "relay did not exit in time, sending SIGKILL");
        managed.child.kill("SIGKILL");
      }
    }, FORCE_KILL_DELAY_MS);
    managed.killTimer.unref();
  }

  stopAll(): void {
    for (const slug of this.processes.keys()) {
      this.stop(slug);
    }
  }

  private canStart(slug: string): boolean {
    const state = this.backoff.get(slug);
    return !state || now() >= state.nextAttempt;
  }

  private registerFailure(slug: string): void {
    const failures = (this.backoff.get(slug)?.failures ?? 0) + 1;
    const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** (failures - 1), RESTART_MAX_DELAY_MS);
    this.backoff.set(slug, { failures, nextAttempt: now() + delay });
    this.options.logger.warn({ slug, failures, delayMs: delay }, "relay restart backing off");
  }

  private finalize(slug: string, managed: ManagedProcess, failed: boolean): void {
    if (managed.ended) {
      return;
    }
    managed.ended = true;
    if (managed.killTimer) {
      clearTimeout(managed.killTimer);
      managed.killTimer = null;
    }
    if (this.processes.get(slug) === managed) {
      this.processes.delete(slug);
    }
    if (failed) {
      this.registerFailure(slug);
    } else {
      this.backoff.delete(slug);
    }
  }

  private start(slug: string, targetUrl: string): void {
    const inputUrl = buildInputUrl(
      this.options.rtmpOrigin,
      slug,
      this.options.readUser,
      this.options.readPass,
    );

    const child = spawn(this.options.ffmpegBin, buildRelayArgs(inputUrl, targetUrl), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const managed: ManagedProcess = {
      child,
      targetUrl,
      stopping: false,
      ended: false,
      killTimer: null,
    };
    this.processes.set(slug, managed);

    child.stderr.on("data", (chunk) => {
      this.options.logger.warn({ slug, output: chunk.toString() }, "relay ffmpeg stderr");
    });

    child.on("error", (error) => {
      this.options.logger.error({ slug, error }, "relay ffmpeg process error");
      this.finalize(slug, managed, !managed.stopping);
    });

    child.on("exit", (code, signal) => {
      this.options.logger.info({ slug, code, signal }, "relay exited");
      this.finalize(slug, managed, !managed.stopping && code !== 0);
    });

    this.options.logger.info({ slug }, "relay started");
  }
}
