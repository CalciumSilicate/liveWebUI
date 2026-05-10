import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";
import { Channel, MediaPath } from "./types";

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

export class ManagedTranscoderManager {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly options: ManagerOptions,
    private readonly profile: TranscoderProfile,
  ) {}

  sync(channels: Channel[], paths: MediaPath[]): void {
    const pathMap = new Map(paths.map((path) => [path.name, path]));
    const enabledChannels = new Map(
      channels.filter((channel) => channel.enabled).map((channel) => [channel.slug, channel]),
    );

    for (const [slug, process] of this.processes) {
      const sourceOnline = pathMap.get(slug)?.online ?? false;
      if (!enabledChannels.has(slug) || !sourceOnline) {
        this.options.logger.info({ slug, profile: this.profile.name }, "stopping transcoder");
        process.kill("SIGTERM");
        this.processes.delete(slug);
      }
    }

    for (const channel of enabledChannels.values()) {
      const sourceOnline = pathMap.get(channel.slug)?.online ?? false;
      if (!sourceOnline || this.processes.has(channel.slug)) {
        continue;
      }
      this.start(channel.slug);
    }
  }

  stop(slug: string): void {
    const process = this.processes.get(slug);
    if (!process) {
      return;
    }
    process.kill("SIGTERM");
    this.processes.delete(slug);
  }

  stopAll(): void {
    for (const slug of this.processes.keys()) {
      this.stop(slug);
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

    child.on("exit", (code, signal) => {
      this.processes.delete(slug);
      this.options.logger.info(
        { slug, profile: this.profile.name, code, signal },
        "transcoder exited",
      );
    });

    this.processes.set(slug, child);
    this.options.logger.info({ slug, profile: this.profile.name }, "transcoder started");
  }
}

export function createHlsProfile(secret: string): TranscoderProfile {
  const inputUser = "__browser_read";
  const inputPass = secret.slice(0, 24);
  const outputUser = "__browser_publish";
  const outputPass = `${secret.slice(0, 12)}hls`;

  return {
    name: "hls",
    outputPrefix: HLS_PLAYBACK_PREFIX,
    inputUser,
    inputPass,
    outputUser,
    outputPass,
    outputProtocol: "rtmp",
    buildArgs(inputUrl, outputUrl) {
      return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts+nobuffer",
        "-rtmp_live",
        "live",
        "-i",
        inputUrl,
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
        "veryfast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "baseline",
        "-level:v",
        "3.1",
        "-g",
        "60",
        "-keyint_min",
        "60",
        "-sc_threshold",
        "0",
        "-x264-params",
        "bframes=0:force-cfr=1",
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
        "-f",
        "flv",
        outputUrl,
      ];
    },
  };
}

export function createWebRtcProfile(secret: string): TranscoderProfile {
  const inputUser = "__browser_read";
  const inputPass = secret.slice(0, 24);
  const outputUser = "__rtc_publish";
  const outputPass = `${secret.slice(0, 12)}rtc`;

  return {
    name: "webrtc",
    outputPrefix: WEBRTC_PLAYBACK_PREFIX,
    inputUser,
    inputPass,
    outputUser,
    outputPass,
    outputProtocol: "rtsp",
    buildArgs(inputUrl, outputUrl) {
      return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts+nobuffer",
        "-rtmp_live",
        "live",
        "-i",
        inputUrl,
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
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "baseline",
        "-level:v",
        "3.1",
        "-g",
        "30",
        "-keyint_min",
        "30",
        "-sc_threshold",
        "0",
        "-x264-params",
        "bframes=0:force-cfr=1",
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
        "-f",
        "rtsp",
        "-rtsp_transport",
        "tcp",
        outputUrl,
      ];
    },
  };
}
