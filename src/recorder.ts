import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { Channel, MediaPath, RecordingFile, RecordingStats } from "./types";
import { now } from "./utils";

const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 30000;
const FORCE_KILL_DELAY_MS = 5000;
const RECORDING_EXTENSION = ".mp4";
const MIN_STABLE_FILE_AGE_MS = 5000;

type ManagedProcess = {
  child: ChildProcessWithoutNullStreams;
  segmentSeconds: number;
  budgetMb: number;
  directory: string;
  stopping: boolean;
  ended: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
};

type BackoffState = {
  failures: number;
  nextAttempt: number;
};

type RecorderOptions = {
  ffmpegBin: string;
  rtmpOrigin: string;
  readUser: string;
  readPass: string;
  rootDir: string;
  logger: FastifyBaseLogger;
};

function buildInputUrl(origin: string, slug: string, user: string, pass: string): string {
  return `${origin}/${encodeURIComponent(slug)}?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`;
}

function safeSegmentSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return 300;
  }
  return Math.min(Math.max(Math.trunc(value), 30), 3600);
}

function safeBudgetMb(value: number): number {
  if (!Number.isFinite(value)) {
    return 2048;
  }
  return Math.min(Math.max(Math.trunc(value), 100), 1024 * 1024);
}

function buildRecordingArgs(inputUrl: string, outputPattern: string, segmentSeconds: number): string[] {
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
    "-c",
    "copy",
    "-f",
    "segment",
    "-segment_time",
    String(segmentSeconds),
    "-reset_timestamps",
    "1",
    "-strftime",
    "1",
    "-segment_format",
    "mp4",
    "-segment_format_options",
    "movflags=+faststart",
    outputPattern,
  ];
}

function ffprobePath(ffmpegBin: string): string {
  return ffmpegBin.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
}

function isReadableMp4(ffmpegBin: string, path: string): boolean {
  const result = spawnSync(
    ffprobePath(ffmpegBin),
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
    { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 },
  );
  return result.status === 0;
}

function listRecordingFiles(directory: string, ffmpegBin: string): RecordingFile[] {
  const stableBefore = now() - MIN_STABLE_FILE_AGE_MS;
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(RECORDING_EXTENSION))
      .map((name) => {
        const path = join(directory, name);
        const stats = statSync(path);
        return {
          name,
          path,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
        };
      })
      .filter((file) => file.mtimeMs < stableBefore && isReadableMp4(ffmpegBin, file.path))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function directorySize(files: RecordingFile[]): number {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

export class RecorderManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly backoff = new Map<string, BackoffState>();

  constructor(private readonly options: RecorderOptions) {
    mkdirSync(options.rootDir, { recursive: true });
  }

  isRecording(slug: string): boolean {
    const managed = this.processes.get(slug);
    return Boolean(managed && !managed.stopping);
  }

  stats(channel: Channel): RecordingStats {
    const directory = this.channelDirectory(channel.slug);
    const files = listRecordingFiles(directory, this.options.ffmpegBin);
    const latestFile = files.length > 0 ? files[files.length - 1] : null;
    const budgetMb = safeBudgetMb(channel.recordingBudgetMb);
    return {
      enabled: channel.recordingEnabled,
      active: this.isRecording(channel.slug),
      segmentSeconds: safeSegmentSeconds(channel.recordingSegmentSeconds),
      budgetMb,
      usedBytes: directorySize(files),
      budgetBytes: budgetMb * 1024 * 1024,
      fileCount: files.length,
      directory,
      latestFile,
    };
  }

  sync(channels: Channel[], paths: MediaPath[]): void {
    const pathMap = new Map(paths.map((path) => [path.name, path]));
    const desired = new Map<string, Channel>();

    for (const channel of channels) {
      const sourceOnline = pathMap.get(channel.slug)?.online ?? false;
      if (channel.enabled && channel.recordingEnabled && sourceOnline) {
        desired.set(channel.slug, channel);
      }
    }

    for (const [slug, managed] of this.processes) {
      if (managed.stopping) {
        continue;
      }
      const channel = desired.get(slug);
      if (
        !channel ||
        managed.segmentSeconds !== safeSegmentSeconds(channel.recordingSegmentSeconds) ||
        managed.budgetMb !== safeBudgetMb(channel.recordingBudgetMb)
      ) {
        this.stop(slug);
      }
    }

    for (const channel of desired.values()) {
      this.enforceBudget(channel.slug, safeBudgetMb(channel.recordingBudgetMb));
      if (this.processes.has(channel.slug) || !this.canStart(channel.slug)) {
        continue;
      }
      this.start(channel);
    }
  }

  stop(slug: string): void {
    const managed = this.processes.get(slug);
    if (!managed || managed.stopping) {
      return;
    }
    managed.stopping = true;
    this.backoff.delete(slug);
    this.options.logger.info({ slug }, "stopping recorder");
    managed.child.kill("SIGTERM");
    managed.killTimer = setTimeout(() => {
      if (!managed.ended) {
        this.options.logger.warn({ slug }, "recorder did not exit in time, sending SIGKILL");
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

  removeChannelRecordings(slug: string): void {
    this.stop(slug);
    rmSync(this.channelDirectory(slug), { recursive: true, force: true });
  }

  private channelDirectory(slug: string): string {
    return resolve(this.options.rootDir, slug);
  }

  private canStart(slug: string): boolean {
    const state = this.backoff.get(slug);
    return !state || now() >= state.nextAttempt;
  }

  private registerFailure(slug: string): void {
    const failures = (this.backoff.get(slug)?.failures ?? 0) + 1;
    const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** (failures - 1), RESTART_MAX_DELAY_MS);
    this.backoff.set(slug, { failures, nextAttempt: now() + delay });
    this.options.logger.warn({ slug, failures, delayMs: delay }, "recorder restart backing off");
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
    this.enforceBudget(slug, managed.budgetMb);
    if (failed) {
      this.registerFailure(slug);
    } else {
      this.backoff.delete(slug);
    }
  }

  private enforceBudget(slug: string, budgetMb: number): void {
    const directory = this.channelDirectory(slug);
    const budgetBytes = safeBudgetMb(budgetMb) * 1024 * 1024;
    const files = listRecordingFiles(directory, this.options.ffmpegBin);
    let usedBytes = directorySize(files);

    for (const file of files) {
      if (usedBytes <= budgetBytes) {
        break;
      }
      try {
        rmSync(file.path, { force: true });
        usedBytes -= file.sizeBytes;
        this.options.logger.info({ slug, file: file.name }, "deleted old recording segment");
      } catch (error) {
        this.options.logger.warn({ slug, file: file.name, error }, "failed to delete old recording segment");
      }
    }
  }

  private start(channel: Channel): void {
    const slug = channel.slug;
    const directory = this.channelDirectory(slug);
    mkdirSync(directory, { recursive: true });

    const segmentSeconds = safeSegmentSeconds(channel.recordingSegmentSeconds);
    const budgetMb = safeBudgetMb(channel.recordingBudgetMb);
    const inputUrl = buildInputUrl(
      this.options.rtmpOrigin,
      slug,
      this.options.readUser,
      this.options.readPass,
    );
    const outputPattern = join(directory, `${slug}-%Y%m%d-%H%M%S${RECORDING_EXTENSION}`);
    const child = spawn(this.options.ffmpegBin, buildRecordingArgs(inputUrl, outputPattern, segmentSeconds), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const managed: ManagedProcess = {
      child,
      segmentSeconds,
      budgetMb,
      directory,
      stopping: false,
      ended: false,
      killTimer: null,
    };
    this.processes.set(slug, managed);

    child.stderr.on("data", (chunk) => {
      this.options.logger.warn({ slug, output: chunk.toString() }, "recorder ffmpeg stderr");
    });

    child.on("error", (error) => {
      this.options.logger.error({ slug, error }, "recorder ffmpeg process error");
      this.finalize(slug, managed, !managed.stopping);
    });

    child.on("exit", (code, signal) => {
      this.options.logger.info({ slug, code, signal }, "recorder exited");
      this.finalize(slug, managed, !managed.stopping && code !== 0);
    });

    this.options.logger.info({ slug, directory, segmentSeconds, budgetMb }, "recorder started");
  }
}
