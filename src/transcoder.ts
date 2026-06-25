import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { Channel, MediaPath } from "./types";
import { now } from "./utils";

export const HLS_PLAYBACK_PREFIX = "__web_";
export const WEBRTC_PLAYBACK_PREFIX = "__rtc_";

export function toHlsPath(slug: string): string {
  return `${HLS_PLAYBACK_PREFIX}${slug}`;
}

export function toWebRtcPath(slug: string): string {
  return `${WEBRTC_PLAYBACK_PREFIX}${slug}`;
}

export function toSourceSlug(pathName: string): string {
  if (pathName.startsWith(HLS_PLAYBACK_PREFIX)) {
    return pathName.slice(HLS_PLAYBACK_PREFIX.length);
  }
  if (pathName.startsWith(WEBRTC_PLAYBACK_PREFIX)) {
    return pathName.slice(WEBRTC_PLAYBACK_PREFIX.length);
  }
  return pathName;
}

type OutputProtocol = "rtmp" | "rtsp";

type TranscoderProfile = {
  name: "hls" | "webrtc";
  outputPrefix: string;
  inputUser: string;
  inputPass: string;
  outputUser: string;
  outputPass: string;
  outputProtocol: OutputProtocol;
  buildArgs: (inputUrl: string, outputUrl: string) => string[];
};

type ManagerOptions = {
  ffmpegBin: string;
  rtmpOrigin: string;
  rtspOrigin: string;
  logger: FastifyBaseLogger;
};

function buildRtmpUrl(origin: string, pathName: string, user: string, pass: string): string {
  return `${origin}/${encodeURIComponent(pathName)}?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(
    pass,
  )}`;
}

function buildRtspUrl(origin: string, pathName: string, user: string, pass: string): string {
  const url = new URL(`${origin}/${encodeURIComponent(pathName)}`);
  url.username = user;
  url.password = pass;
  return url.toString();
}

const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 30000;
const FORCE_KILL_DELAY_MS = 5000;

type ManagedProcess = {
  child: ChildProcessWithoutNullStreams;
  stopping: boolean;
  ended: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
};

type BackoffState = {
  failures: number;
  nextAttempt: number;
};

export class ManagedTranscoderManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly backoff = new Map<string, BackoffState>();

  constructor(
    private readonly options: ManagerOptions,
    private readonly profile: TranscoderProfile,
  ) {}

  sync(channels: Channel[], paths: MediaPath[]): void {
    const pathMap = new Map(paths.map((path) => [path.name, path]));
    const enabledChannels = new Map(
      channels.filter((channel) => channel.enabled).map((channel) => [channel.slug, channel]),
    );

    for (const [slug, managed] of this.processes) {
      if (managed.stopping) {
        continue;
      }
      const sourceOnline = pathMap.get(slug)?.online ?? false;
      if (!enabledChannels.has(slug) || !sourceOnline) {
        this.stop(slug);
      }
    }

    for (const channel of enabledChannels.values()) {
      const sourceOnline = pathMap.get(channel.slug)?.online ?? false;
      if (!sourceOnline || this.processes.has(channel.slug) || !this.canStart(channel.slug)) {
        continue;
      }
      this.start(channel.slug);
    }
  }

  stop(slug: string): void {
    const managed = this.processes.get(slug);
    if (!managed || managed.stopping) {
      return;
    }
    // 主动停止:清掉退避计数,并标记 stopping 以阻止本进程退出后被立即重启。
    // 不在此处删除 processes,等 exit/error 回调统一清理,避免与重启产生竞态。
    managed.stopping = true;
    this.backoff.delete(slug);
    this.options.logger.info({ slug, profile: this.profile.name }, "stopping transcoder");
    managed.child.kill("SIGTERM");
    managed.killTimer = setTimeout(() => {
      if (!managed.ended) {
        this.options.logger.warn(
          { slug, profile: this.profile.name },
          "transcoder did not exit in time, sending SIGKILL",
        );
        managed.child.kill("SIGKILL");
      }
    }, FORCE_KILL_DELAY_MS);
    managed.killTimer.unref();
  }

  stopAll(): void {
    // stop() 只标记 stopping、不删除 processes,因此迭代 keys 是安全的。
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
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** (failures - 1),
      RESTART_MAX_DELAY_MS,
    );
    this.backoff.set(slug, { failures, nextAttempt: now() + delay });
    this.options.logger.warn(
      { slug, profile: this.profile.name, failures, delayMs: delay },
      "transcoder restart backing off",
    );
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
    // 仅当 map 中仍是这个进程时才删除,避免误删一个已经重启的新进程。
    if (this.processes.get(slug) === managed) {
      this.processes.delete(slug);
    }
    if (failed) {
      this.registerFailure(slug);
    } else {
      this.backoff.delete(slug);
    }
  }

  private start(slug: string): void {
    const inputUrl = buildRtmpUrl(
      this.options.rtmpOrigin,
      slug,
      this.profile.inputUser,
      this.profile.inputPass,
    );
    const outputPath = `${this.profile.outputPrefix}${slug}`;
    const outputUrl =
      this.profile.outputProtocol === "rtmp"
        ? buildRtmpUrl(
            this.options.rtmpOrigin,
            outputPath,
            this.profile.outputUser,
            this.profile.outputPass,
          )
        : buildRtspUrl(
            this.options.rtspOrigin,
            outputPath,
            this.profile.outputUser,
            this.profile.outputPass,
          );

    const child = spawn(this.options.ffmpegBin, this.profile.buildArgs(inputUrl, outputUrl), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const managed: ManagedProcess = {
      child,
      stopping: false,
      ended: false,
      killTimer: null,
    };
    this.processes.set(slug, managed);

    child.stdout.on("data", (chunk) => {
      this.options.logger.debug(
        { slug, profile: this.profile.name, output: chunk.toString() },
        "ffmpeg stdout",
      );
    });

    child.stderr.on("data", (chunk) => {
      this.options.logger.warn(
        { slug, profile: this.profile.name, output: chunk.toString() },
        "ffmpeg stderr",
      );
    });

    // spawn 失败(例如 ffmpeg 不存在)会 emit "error";不监听会抛出未捕获异常拖垮整个进程。
    child.on("error", (error) => {
      this.options.logger.error(
        { slug, profile: this.profile.name, error },
        "ffmpeg process error",
      );
      this.finalize(slug, managed, !managed.stopping);
    });

    child.on("exit", (code, signal) => {
      this.options.logger.info(
        { slug, profile: this.profile.name, code, signal },
        "transcoder exited",
      );
      this.finalize(slug, managed, !managed.stopping && code !== 0);
    });

    this.options.logger.info({ slug, profile: this.profile.name }, "transcoder started");
  }
}

function deriveSecret(secret: string, label: string): string {
  return createHmac("sha256", secret).update(label).digest("base64url").slice(0, 24);
}

// HLS 与 WebRTC 转码都以同一组"内部读取者"身份回拉源流。
// server.ts 的 /internal/mediamtx/auth(read/rtmp 分支)据此放行,两个 profile 必须共用这组凭证。
function internalReadCredentials(secret: string): { user: string; pass: string } {
  return {
    user: "__internal_read",
    pass: deriveSecret(secret, "transcoder-read"),
  };
}

type FfmpegArgsOptions = {
  inputUrl: string;
  outputUrl: string;
  videoPreset: string;
  gop: number;
  audioArgs: string[];
  outputArgs: string[];
};

function buildFfmpegArgs(options: FfmpegArgsOptions): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts+nobuffer",
    "-rtmp_live",
    "live",
    "-i",
    options.inputUrl,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-r",
    "30",
    "-vsync",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    options.videoPreset,
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "baseline",
    "-level:v",
    "3.1",
    "-g",
    String(options.gop),
    "-keyint_min",
    String(options.gop),
    "-sc_threshold",
    "0",
    "-x264-params",
    "bframes=0:force-cfr=1",
    ...options.audioArgs,
    ...options.outputArgs,
    options.outputUrl,
  ];
}

export function createHlsProfile(secret: string): TranscoderProfile {
  const read = internalReadCredentials(secret);

  return {
    name: "hls",
    outputPrefix: HLS_PLAYBACK_PREFIX,
    inputUser: read.user,
    inputPass: read.pass,
    outputUser: "__hls_publish",
    outputPass: deriveSecret(secret, "hls-publish"),
    outputProtocol: "rtmp",
    buildArgs(inputUrl, outputUrl) {
      return buildFfmpegArgs({
        inputUrl,
        outputUrl,
        videoPreset: "veryfast",
        gop: 60,
        audioArgs: [
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-b:a",
          "128k",
          "-ac",
          "2",
          "-af",
          "aresample=async=1:first_pts=0",
        ],
        outputArgs: ["-f", "flv"],
      });
    },
  };
}

export function createWebRtcProfile(secret: string): TranscoderProfile {
  const read = internalReadCredentials(secret);

  return {
    name: "webrtc",
    outputPrefix: WEBRTC_PLAYBACK_PREFIX,
    inputUser: read.user,
    inputPass: read.pass,
    outputUser: "__rtc_publish",
    outputPass: deriveSecret(secret, "rtc-publish"),
    outputProtocol: "rtsp",
    buildArgs(inputUrl, outputUrl) {
      return buildFfmpegArgs({
        inputUrl,
        outputUrl,
        videoPreset: "ultrafast",
        gop: 30,
        audioArgs: [
          "-c:a",
          "libopus",
          "-application",
          "lowdelay",
          "-frame_duration",
          "20",
          "-b:a",
          "64k",
          "-ac",
          "2",
          "-ar",
          "48000",
        ],
        outputArgs: ["-f", "rtsp", "-rtsp_transport", "tcp"],
      });
    },
  };
}
