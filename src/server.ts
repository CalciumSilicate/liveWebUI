import { setInterval } from "node:timers";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import type { RawData, WebSocket } from "ws";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { AppDatabase } from "./db";
import { MediaService } from "./media";
import { Channel, CommentView, MediaPath } from "./types";
import { createAdminToken, createViewerToken, verifyAdminToken, verifyViewerToken } from "./token";
import {
  normalizeSlug,
  secureEqual,
  trimText,
  validateSlug,
} from "./utils";
import {
  createHlsProfile,
  createWebRtcProfile,
  ManagedTranscoderManager,
  toHlsPath,
  toSourceSlug,
  toWebRtcPath,
} from "./transcoder";
import { RelayManager } from "./relay";
import { RecorderManager } from "./recorder";
import { RecordingLibrary } from "./recording-library";

type Config = {
  appPort: number;
  adminPassword: string;
  sessionSecret: string;
  mediaApiUrl: string;
  mediaHlsOrigin: string;
  mediaRtmpOrigin: string;
  mediaRtspOrigin: string;
  dbPath: string;
  ffmpegBin: string;
  publicWebRtcPort: number;
  recordingsDir: string;
};

type ChannelRuntimeInfo = {
  sourceOnline: boolean;
  hlsOnline: boolean;
  webrtcOnline: boolean;
  hlsReaders: number;
  webrtcReaders: number;
};

function readSecretEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Set it in the environment or docker compose .env file.`);
  }
  return value;
}

function loadConfig(): Config {
  const cwd = process.cwd();
  return {
    appPort: Number(process.env.APP_PORT ?? 42110),
    adminPassword: readSecretEnv("ADMIN_PASSWORD"),
    sessionSecret: readSecretEnv("SESSION_SECRET"),
    mediaApiUrl: process.env.MEDIA_API_URL ?? "http://127.0.0.1:9997",
    mediaHlsOrigin: process.env.MEDIA_HLS_ORIGIN ?? "http://127.0.0.1:8888",
    mediaRtmpOrigin: process.env.MEDIA_RTMP_ORIGIN ?? "rtmp://mediamtx:1935",
    mediaRtspOrigin: process.env.MEDIA_RTSP_ORIGIN ?? "rtsp://mediamtx:8554",
    dbPath: process.env.DB_PATH ?? resolve(cwd, "data", "app.db"),
    ffmpegBin: process.env.FFMPEG_BIN ?? "/usr/bin/ffmpeg",
    publicWebRtcPort: Number(process.env.PUBLIC_WEBRTC_PORT ?? 42113),
    recordingsDir: process.env.RECORDINGS_DIR ?? resolve(cwd, "data", "recordings"),
  };
}

const config = loadConfig();

// 前端 SPA 的构建产物目录。相对 __dirname 解析,兼顾 dev(src/)、构建(dist/)与 Docker(/app/dist):
// 三种情况下 `../web/dist` 都指向同一份产物;可用 WEB_DIST 环境变量覆盖。
const webDistDir = process.env.WEB_DIST ?? resolve(__dirname, "..", "web", "dist");

const db = new AppDatabase(config.dbPath);
const media = new MediaService(config.mediaApiUrl);
const hlsProfile = createHlsProfile(config.sessionSecret);
const webrtcProfile = createWebRtcProfile(config.sessionSecret);
const app = Fastify({
  logger: true,
});
const hlsTranscoder = new ManagedTranscoderManager(
  {
    ffmpegBin: config.ffmpegBin,
    rtmpOrigin: config.mediaRtmpOrigin,
    rtspOrigin: config.mediaRtspOrigin,
    logger: app.log,
  },
  hlsProfile,
);
const webrtcTranscoder = new ManagedTranscoderManager(
  {
    ffmpegBin: config.ffmpegBin,
    rtmpOrigin: config.mediaRtmpOrigin,
    rtspOrigin: config.mediaRtspOrigin,
    logger: app.log,
  },
  webrtcProfile,
);

// 每个在线渠道会同时运行两个转码进程:HLS(veryfast/AAC,兼容播放)与 WebRTC(ultrafast/Opus,低延迟)。
// 二者编码参数与输出协议不同,无法共用同一路输出,因此按渠道各跑一个,代价是 CPU/内存翻倍。
const transcoderManagers = [
  hlsTranscoder,
  webrtcTranscoder,
];

// 转推:把在线源用 -c copy 原样转发到渠道配置的外部 RTMP 目标。拉源复用 HLS/WebRTC 的内部读凭证。
const relayManager = new RelayManager({
  ffmpegBin: config.ffmpegBin,
  rtmpOrigin: config.mediaRtmpOrigin,
  readUser: hlsProfile.inputUser,
  readPass: hlsProfile.inputPass,
  logger: app.log,
});
const recorderManager = new RecorderManager({
  ffmpegBin: config.ffmpegBin,
  rtmpOrigin: config.mediaRtmpOrigin,
  readUser: hlsProfile.inputUser,
  readPass: hlsProfile.inputPass,
  rootDir: config.recordingsDir,
  logger: app.log,
});
const recordingLibrary = new RecordingLibrary({
  ffmpegBin: config.ffmpegBin,
  rootDir: config.recordingsDir,
  logger: app.log,
});

function stopTranscodersForSlug(slug: string): void {
  for (const manager of transcoderManagers) {
    manager.stop(slug);
  }
  relayManager.stop(slug);
  recorderManager.stop(slug);
}

function buildWebRtcWhepUrl(request: { protocol: string; headers: { host?: string } }, slug: string): string {
  const base = withBaseUrl(request);
  const url = new URL(base.origin);
  url.port = String(config.publicWebRtcPort);
  url.pathname = `/${toWebRtcPath(slug)}/whep`;
  return url.toString();
}

function runtimeFromPathMap(pathMap: Map<string, { online: boolean; readers: number }>, slug: string): ChannelRuntimeInfo {
  const source = pathMap.get(slug);
  const hls = pathMap.get(toHlsPath(slug));
  const webrtc = pathMap.get(toWebRtcPath(slug));
  return {
    sourceOnline: source?.online ?? false,
    hlsOnline: hls?.online ?? false,
    webrtcOnline: webrtc?.online ?? false,
    hlsReaders: hls?.readers ?? 0,
    webrtcReaders: webrtc?.readers ?? 0,
  };
}

function viewerModePayload(
  request: { protocol: string; headers: { host?: string } },
  channel: Channel,
  runtime: ChannelRuntimeInfo,
) {
  return {
    sourceOnline: runtime.sourceOnline,
    webrtcOnline: runtime.webrtcOnline,
    hlsOnline: runtime.hlsOnline,
    readers: runtime.hlsReaders + runtime.webrtcReaders,
    defaultMode: runtime.webrtcOnline ? "webrtc" : "hls",
    modes: {
      webrtc: {
        available: runtime.sourceOnline,
        online: runtime.webrtcOnline,
        whepUrl: buildWebRtcWhepUrl(request, channel.slug),
      },
      hls: {
        available: runtime.sourceOnline,
        online: runtime.hlsOnline,
        playlistUrl: `/media/${toHlsPath(channel.slug)}/index.m3u8`,
      },
    },
  };
}

const viewerSockets = new Map<string, Set<WebSocket>>();

function addViewerSocket(slug: string, socket: WebSocket): void {
  const set = viewerSockets.get(slug) ?? new Set<WebSocket>();
  set.add(socket);
  viewerSockets.set(slug, set);
}

function removeViewerSocket(slug: string, socket: WebSocket): void {
  const set = viewerSockets.get(slug);
  if (!set) {
    return;
  }
  set.delete(socket);
  if (set.size === 0) {
    viewerSockets.delete(slug);
  }
}

function disconnectViewerSockets(slug: string): void {
  const set = viewerSockets.get(slug);
  if (!set) {
    return;
  }
  for (const socket of set) {
    socket.close(4001, "refresh");
  }
  viewerSockets.delete(slug);
}

function broadcastComment(slug: string, comment: CommentView): void {
  const set = viewerSockets.get(slug);
  if (!set) {
    return;
  }
  const payload = JSON.stringify({
    type: "comment",
    comment,
  });
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}

function getAdminToken(request: { cookies: Record<string, string | undefined> }): string | null {
  return request.cookies.admin_session ?? null;
}

function requireAdmin(
  request: { cookies: Record<string, string | undefined> },
): boolean {
  const token = getAdminToken(request);
  if (!token) {
    return false;
  }
  return verifyAdminToken(config.sessionSecret, token) !== null;
}

function getBearerToken(headerValue?: string): string | null {
  if (!headerValue) {
    return null;
  }
  const [scheme, value] = headerValue.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !value) {
    return null;
  }
  return value.trim();
}

function getQueryToken(urlValue?: string): string | null {
  if (!urlValue) {
    return null;
  }
  const url = new URL(urlValue, "http://127.0.0.1");
  return url.searchParams.get("token");
}

function viewerCookieName(slug: string): string {
  return `viewer_access_${slug}`;
}

function verifyViewerAccess(slug: string, token: string | null): Channel | null {
  if (!token) {
    return null;
  }
  const payload = verifyViewerToken(config.sessionSecret, token);
  if (!payload) {
    return null;
  }
  const channel = db.getChannelBySlug(slug);
  if (!channel || !channel.enabled) {
    return null;
  }
  if (payload.slug !== channel.slug || payload.authVersion !== channel.authVersion) {
    return null;
  }
  return channel;
}

function getViewerTokenFromRequest(
  request: {
    headers: { authorization?: string };
    raw: { url?: string };
    cookies: Record<string, string | undefined>;
  },
  slug: string,
): string | null {
  return (
    getBearerToken(request.headers.authorization) ??
    getQueryToken(request.raw.url) ??
    request.cookies[viewerCookieName(slug)] ??
    null
  );
}

function isMediaStaticAsset(pathName: string): boolean {
  return !pathName.includes("/") && /\.[a-z0-9]+$/i.test(pathName);
}

function withBaseUrl(request: { protocol: string; headers: { host?: string } }): URL {
  return new URL(`${request.protocol}://${request.headers.host ?? `127.0.0.1:${config.appPort}`}`);
}

function channelUrls(baseUrl: URL, channel: Channel): {
  pushUrl: string;
  watchUrl: string;
} {
  const pushUrl = `rtmp://${baseUrl.hostname}:42111/${channel.slug}?user=${encodeURIComponent(
    channel.slug,
  )}&pass=${encodeURIComponent(channel.publishPassword)}`;

  return {
    pushUrl,
    watchUrl: `${baseUrl.origin}/watch/${channel.slug}`,
  };
}

function buildStatusMap(paths: MediaPath[]): Map<string, { online: boolean; readers: number }> {
  const map = new Map<string, { online: boolean; readers: number }>();
  for (const item of paths) {
    map.set(item.name, {
      online: item.online,
      readers: item.readers?.length ?? 0,
    });
  }
  return map;
}

async function channelStatusMap(): Promise<Map<string, { online: boolean; readers: number }>> {
  try {
    return buildStatusMap(await media.listPaths());
  } catch (error) {
    app.log.error(error, "failed to load MediaMTX paths");
    return new Map();
  }
}

async function syncTranscoders(paths?: MediaPath[]): Promise<void> {
  try {
    const channels = db.listChannels();
    const resolvedPaths = paths ?? (await media.listPaths());
    for (const manager of transcoderManagers) {
      manager.sync(channels, resolvedPaths);
    }
    relayManager.sync(channels, resolvedPaths);
    recorderManager.sync(channels, resolvedPaths);
  } catch (error) {
    app.log.error(error, "failed to sync browser transcoders");
  }
}

// 拉取一次 MediaMTX 路径,既驱动转码调谐又返回状态表,避免同一请求内重复查询。
async function refreshAndGetStatus(): Promise<Map<string, { online: boolean; readers: number }>> {
  let paths: MediaPath[];
  try {
    paths = await media.listPaths();
  } catch (error) {
    app.log.error(error, "failed to load MediaMTX paths");
    return new Map();
  }
  await syncTranscoders(paths);
  return buildStatusMap(paths);
}

app.register(fastifyCookie);
// SPA 静态资源:index.html、/assets/*(带 hash 的 JS/CSS)、/fonts/*、favicon。
// 未命中的文件会走 setNotFoundHandler,由那里回退到 index.html 支撑前端路由。
app.register(fastifyStatic, {
  root: webDistDir,
  prefix: "/",
});

app.get("/health", async () => ({
  ok: true,
}));

app.post("/api/admin/login", async (request, reply) => {
  const body = request.body as { password?: string };
  const password = body?.password ?? "";
  if (!password || !secureEqual(password, config.adminPassword)) {
    return reply.code(401).send({ error: "密码错误" });
  }

  reply.setCookie("admin_session", createAdminToken(config.sessionSecret), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  return { ok: true };
});

app.post("/api/admin/logout", async (_, reply) => {
  reply.clearCookie("admin_session", {
    path: "/",
  });
  return { ok: true };
});

app.get("/api/admin/session", async (request) => ({
  authenticated: requireAdmin(request),
}));

app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/admin/")) {
    return;
  }
  if (request.url === "/api/admin/login" || request.url === "/api/admin/session") {
    return;
  }
  if (!requireAdmin(request)) {
    await reply.code(401).send({ error: "未登录" });
  }
});

app.get("/api/admin/channels", async (request) => {
  const baseUrl = withBaseUrl(request);
  const pathMap = await channelStatusMap();

  return db.listChannels().map((channel) => {
    const runtime = runtimeFromPathMap(pathMap, channel.slug);
    const state = !channel.enabled ? "已停用" : runtime.sourceOnline ? "直播中" : "未直播";
    return {
      ...channel,
      ...channelUrls(baseUrl, channel),
      online: runtime.sourceOnline,
      readers: runtime.hlsReaders + runtime.webrtcReaders,
      state,
      sourceOnline: runtime.sourceOnline,
      hlsOnline: runtime.hlsOnline,
      webrtcOnline: runtime.webrtcOnline,
      hlsReaders: runtime.hlsReaders,
      webrtcReaders: runtime.webrtcReaders,
      // 转推是否已配置目标、以及当前是否有活跃转推进程。
      relayConfigured: channel.relayUrl.trim().length > 0,
      relaying: relayManager.isRelaying(channel.slug),
      recording: recorderManager.stats(channel),
    };
  });
});

// 转推服务器地址:空字符串表示不转推;旧数据可继续使用包含推流码的完整地址。
function normalizeRelayUrl(value: string): { ok: true; url: string } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, url: "" };
  }
  if (!/^rtmps?:\/\//i.test(trimmed)) {
    return { ok: false };
  }
  return { ok: true, url: trimmed };
}

function normalizeRelayStreamKey(value: string): string {
  return value.trim();
}

function normalizeRecordingSettings(input: {
  recordingEnabled?: boolean;
  recordingSegmentSeconds?: number;
  recordingBudgetMb?: number;
}): {
  ok: true;
  recordingEnabled: boolean;
  recordingSegmentSeconds: number;
  recordingBudgetMb: number;
} | { ok: false; error: string } {
  const recordingEnabled = input.recordingEnabled === true;
  const recordingSegmentSeconds = Number(input.recordingSegmentSeconds ?? 300);
  const recordingBudgetMb = Number(input.recordingBudgetMb ?? 2048);

  if (!Number.isFinite(recordingSegmentSeconds) || recordingSegmentSeconds < 30 || recordingSegmentSeconds > 3600) {
    return { ok: false, error: "录制分片时长需在 30-3600 秒之间" };
  }
  if (!Number.isFinite(recordingBudgetMb) || recordingBudgetMb < 100 || recordingBudgetMb > 1024 * 1024) {
    return { ok: false, error: "录制空间预算需在 100MB-1TB 之间" };
  }

  return {
    ok: true,
    recordingEnabled,
    recordingSegmentSeconds: Math.trunc(recordingSegmentSeconds),
    recordingBudgetMb: Math.trunc(recordingBudgetMb),
  };
}

app.post("/api/admin/channels", async (request, reply) => {
  const body = request.body as {
    slug?: string;
    label?: string;
    publishPassword?: string;
    viewerPassword?: string;
    relayUrl?: string;
    relayStreamKey?: string;
    recordingEnabled?: boolean;
    recordingSegmentSeconds?: number;
    recordingBudgetMb?: number;
    enabled?: boolean;
  };

  const slug = normalizeSlug(body?.slug ?? "");
  const label = trimText(body?.label ?? "");
  const publishPassword = body?.publishPassword ?? "";
  const viewerPassword = body?.viewerPassword ?? "";
  const enabled = body?.enabled !== false;
  const relay = normalizeRelayUrl(body?.relayUrl ?? "");
  const relayStreamKey = normalizeRelayStreamKey(body?.relayStreamKey ?? "");
  const recording = normalizeRecordingSettings(body ?? {});

  if (!validateSlug(slug)) {
    return reply.code(400).send({ error: "slug 需为 3-32 位小写字母、数字或 -" });
  }
  if (!label) {
    return reply.code(400).send({ error: "名称不能为空" });
  }
  if (!publishPassword || !viewerPassword) {
    return reply.code(400).send({ error: "密码不能为空" });
  }
  if (!relay.ok) {
    return reply.code(400).send({ error: "转推地址需以 rtmp:// 或 rtmps:// 开头" });
  }
  if (!relay.url && relayStreamKey) {
    return reply.code(400).send({ error: "设置转推推流码前请先填写转推地址" });
  }
  if (!recording.ok) {
    return reply.code(400).send({ error: recording.error });
  }

  try {
    const channel = db.createChannel({
      slug,
      label,
      publishPassword,
      viewerPassword,
      relayUrl: relay.url,
      relayStreamKey,
      recordingEnabled: recording.recordingEnabled,
      recordingSegmentSeconds: recording.recordingSegmentSeconds,
      recordingBudgetMb: recording.recordingBudgetMb,
      enabled,
    });
    return reply.code(201).send(channel);
  } catch (error) {
    request.log.error(error);
    return reply.code(409).send({ error: "slug 已存在" });
  }
});

app.patch("/api/admin/channels/:id", async (request, reply) => {
  const channelId = Number((request.params as { id: string }).id);
  const body = request.body as {
    slug?: string;
    label?: string;
    publishPassword?: string;
    viewerPassword?: string;
    relayUrl?: string;
    relayStreamKey?: string;
    recordingEnabled?: boolean;
    recordingSegmentSeconds?: number;
    recordingBudgetMb?: number;
  };

  const input: {
    slug?: string;
    label?: string;
    publishPassword?: string;
    viewerPassword?: string;
    relayUrl?: string;
    relayStreamKey?: string;
    recordingEnabled?: boolean;
    recordingSegmentSeconds?: number;
    recordingBudgetMb?: number;
  } = {};

  if (body.slug !== undefined) {
    const slug = normalizeSlug(body.slug);
    if (!validateSlug(slug)) {
      return reply.code(400).send({ error: "slug 无效" });
    }
    input.slug = slug;
  }
  if (body.label !== undefined) {
    const label = trimText(body.label);
    if (!label) {
      return reply.code(400).send({ error: "名称不能为空" });
    }
    input.label = label;
  }
  if (body.publishPassword !== undefined) {
    if (!body.publishPassword) {
      return reply.code(400).send({ error: "推流码不能为空" });
    }
    input.publishPassword = body.publishPassword;
  }
  if (body.viewerPassword !== undefined) {
    if (!body.viewerPassword) {
      return reply.code(400).send({ error: "观看码不能为空" });
    }
    input.viewerPassword = body.viewerPassword;
  }
  if (body.relayUrl !== undefined || body.relayStreamKey !== undefined) {
    const current = db.getChannelById(channelId);
    if (!current) {
      return reply.code(404).send({ error: "渠道不存在" });
    }
    const relay = normalizeRelayUrl(body.relayUrl ?? current.relayUrl);
    const relayStreamKey = normalizeRelayStreamKey(
      body.relayStreamKey ?? current.relayStreamKey,
    );
    if (!relay.ok) {
      return reply.code(400).send({ error: "转推地址需以 rtmp:// 或 rtmps:// 开头" });
    }
    if (!relay.url && relayStreamKey) {
      return reply.code(400).send({ error: "设置转推推流码前请先填写转推地址" });
    }
    input.relayUrl = relay.url;
    input.relayStreamKey = relayStreamKey;
  }
  if (
    body.recordingEnabled !== undefined ||
    body.recordingSegmentSeconds !== undefined ||
    body.recordingBudgetMb !== undefined
  ) {
    const current = db.getChannelById(channelId);
    if (!current) {
      return reply.code(404).send({ error: "渠道不存在" });
    }
    const recording = normalizeRecordingSettings({
      recordingEnabled: body.recordingEnabled ?? current.recordingEnabled,
      recordingSegmentSeconds: body.recordingSegmentSeconds ?? current.recordingSegmentSeconds,
      recordingBudgetMb: body.recordingBudgetMb ?? current.recordingBudgetMb,
    });
    if (!recording.ok) {
      return reply.code(400).send({ error: recording.error });
    }
    input.recordingEnabled = recording.recordingEnabled;
    input.recordingSegmentSeconds = recording.recordingSegmentSeconds;
    input.recordingBudgetMb = recording.recordingBudgetMb;
  }

  try {
    const { before, after } = db.updateChannel(channelId, input);
    const slugChanged = before.slug !== after.slug;
    const viewerPasswordChanged = before.viewerPassword !== after.viewerPassword;

    // 观看码或 slug 变化都会使旧的观看 token 失效(authVersion 已自增),需断开现有观众重新鉴权。
    if (slugChanged || viewerPasswordChanged) {
      disconnectViewerSockets(before.slug);
    }

    // 仅 slug 变化才需停掉旧 slug 的转码并踢掉推流端;改观看码不影响推拉流,无需打断转码。
    if (slugChanged) {
      stopTranscodersForSlug(before.slug);
      try {
        await media.kickChannelPublishers(before.slug);
      } catch (error) {
        request.log.error(error, "failed to kick publishers after slug change");
      }
    }
    // 立即同步一次:改了转推目标能尽快按新地址起/停,不用等下一轮定时轮询。
    // 录制配置变化也在这里生效:分片时长/预算变更会重启对应录制进程。
    void syncTranscoders();
    return after;
  } catch (error) {
    request.log.error(error);
    return reply.code(409).send({ error: "更新失败" });
  }
});

app.post("/api/admin/channels/:id/enable", async (request, reply) => {
  const channelId = Number((request.params as { id: string }).id);

  try {
    const { after } = db.setChannelEnabled(channelId, true);
    disconnectViewerSockets(after.slug);
    await syncTranscoders();
    return after;
  } catch (error) {
    request.log.error(error);
    return reply.code(404).send({ error: "渠道不存在" });
  }
});

app.post("/api/admin/channels/:id/disable", async (request, reply) => {
  const channelId = Number((request.params as { id: string }).id);

  try {
    const { before, after } = db.setChannelEnabled(channelId, false);
    disconnectViewerSockets(before.slug);
    stopTranscodersForSlug(before.slug);
    try {
      await media.kickChannelPublishers(before.slug);
    } catch (error) {
      request.log.error(error, "failed to kick publishers on disable");
    }
    return after;
  } catch (error) {
    request.log.error(error);
    return reply.code(404).send({ error: "渠道不存在" });
  }
});

app.delete("/api/admin/channels/:id", async (request, reply) => {
  const channelId = Number((request.params as { id: string }).id);
  const channel = db.deleteChannel(channelId);
  if (!channel) {
    return reply.code(404).send({ error: "渠道不存在" });
  }
  disconnectViewerSockets(channel.slug);
  stopTranscodersForSlug(channel.slug);
  recorderManager.removeChannelRecordings(channel.slug);
  try {
    await media.kickChannelPublishers(channel.slug);
  } catch (error) {
    request.log.error(error, "failed to kick publishers on delete");
  }
  return { ok: true };
});

app.get("/api/admin/recordings", async () => recordingLibrary.list());

app.patch("/api/admin/recordings/:id", async (request, reply) => {
  const id = decodeURIComponent((request.params as { id: string }).id);
  const asset = recordingLibrary.patch(id, request.body as {
    title?: string;
    note?: string;
    marked?: boolean;
    inPointSec?: number | null;
    outPointSec?: number | null;
  });
  if (!asset) {
    return reply.code(404).send({ error: "录制文件不存在" });
  }
  return asset;
});

app.delete("/api/admin/recordings/:id", async (request, reply) => {
  const id = decodeURIComponent((request.params as { id: string }).id);
  if (!recordingLibrary.delete(id)) {
    return reply.code(404).send({ error: "录制文件不存在" });
  }
  return { ok: true };
});

app.post("/api/admin/recordings/export", async (request, reply) => {
  const body = request.body as {
    sourceIds?: string[];
    startSec?: number;
    endSec?: number;
    title?: string;
  };
  try {
    return await recordingLibrary.exportClip({
      sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds : [],
      startSec: Number(body.startSec),
      endSec: Number(body.endSec),
      title: body.title,
    });
  } catch (error) {
    request.log.warn(error, "recording export failed");
    return reply.code(400).send({ error: error instanceof Error ? error.message : "导出失败" });
  }
});

app.route({
  method: ["GET", "HEAD"],
  url: "/api/admin/recordings/:id/media",
  handler: async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const sent = recordingLibrary.sendFile(reply, id, request.headers.range, false);
    if (!sent) {
      return reply.code(404).send({ error: "录制文件不存在" });
    }
    return sent;
  },
});

app.route({
  method: ["GET", "HEAD"],
  url: "/api/admin/recordings/:id/download",
  handler: async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const sent = recordingLibrary.sendFile(reply, id, request.headers.range, true);
    if (!sent) {
      return reply.code(404).send({ error: "录制文件不存在" });
    }
    return sent;
  },
});

app.post("/api/public/channels/:slug/access", async (request, reply) => {
  const slug = normalizeSlug((request.params as { slug: string }).slug);
  const channel = db.getChannelBySlug(slug);
  const body = request.body as { password?: string };

  if (!channel || !channel.enabled || !body?.password || !secureEqual(body.password, channel.viewerPassword)) {
    reply.clearCookie(viewerCookieName(slug), {
      path: "/",
    });
    reply.clearCookie(viewerCookieName(slug), {
      path: `/media/${slug}`,
    });
    return reply.code(401).send({ error: "访问被拒绝" });
  }

  const pathMap = await refreshAndGetStatus();
  const runtime = runtimeFromPathMap(pathMap, channel.slug);

  const token = createViewerToken(config.sessionSecret, channel.slug, channel.authVersion);
  reply.setCookie(viewerCookieName(channel.slug), token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  return {
    token,
    channel: {
      slug: channel.slug,
      label: channel.label,
      enabled: channel.enabled,
      ...viewerModePayload(request, channel, runtime),
    },
  };
});

app.get("/api/public/channels/:slug", async (request, reply) => {
  const slug = normalizeSlug((request.params as { slug: string }).slug);
  const token = getViewerTokenFromRequest(request, slug);
  const channel = verifyViewerAccess(slug, token);
  if (!channel) {
    return reply.code(401).send({ error: "未授权" });
  }

  const pathMap = await refreshAndGetStatus();
  const runtime = runtimeFromPathMap(pathMap, channel.slug);

  return {
    slug: channel.slug,
    label: channel.label,
    enabled: channel.enabled,
    ...viewerModePayload(request, channel, runtime),
  };
});

app.get("/api/public/channels/:slug/comments", async (request, reply) => {
  const slug = normalizeSlug((request.params as { slug: string }).slug);
  const token = getViewerTokenFromRequest(request, slug);
  const channel = verifyViewerAccess(slug, token);
  if (!channel) {
    return reply.code(401).send({ error: "未授权" });
  }

  return db.listRecentComments(channel.id, 50);
});

app.post("/internal/mediamtx/auth", async (request, reply) => {
  const body = request.body as {
    user?: string;
    password?: string;
    token?: string;
    action?: string;
    path?: string;
    protocol?: string;
  };

  const action = body?.action ?? "";
  const protocol = body?.protocol ?? "";
  const requestedPath = normalizeSlug(body?.path ?? "");
  const slug = normalizeSlug(toSourceSlug(requestedPath));
  const channel = db.getChannelBySlug(slug);

  if (action === "publish" && protocol === "rtmp") {
    if (
      requestedPath === toHlsPath(slug) &&
      body.user === hlsProfile.outputUser &&
      body.password === hlsProfile.outputPass
    ) {
      return { ok: true };
    }
    if (!channel || !channel.enabled) {
      return reply.code(401).send({ error: "denied" });
    }
    if (
      body.user === channel.slug &&
      typeof body.password === "string" &&
      secureEqual(body.password, channel.publishPassword)
    ) {
      return { ok: true };
    }
    return reply.code(401).send({ error: "denied" });
  }

  if (action === "publish" && protocol === "rtsp") {
    if (
      requestedPath === toWebRtcPath(slug) &&
      body.user === webrtcProfile.outputUser &&
      body.password === webrtcProfile.outputPass &&
      channel &&
      channel.enabled
    ) {
      return { ok: true };
    }
    return reply.code(401).send({ error: "denied" });
  }

  if (action === "read" && protocol === "rtmp") {
    // HLS 与 WebRTC 转码共用同一组内部读取凭证(见 transcoder.ts internalReadCredentials),故只需校验其一。
    if (
      body.user === hlsProfile.inputUser &&
      body.password === hlsProfile.inputPass &&
      channel &&
      channel.enabled &&
      requestedPath === slug
    ) {
      return { ok: true };
    }
    return reply.code(401).send({ error: "denied" });
  }

  if (action === "read" && protocol === "webrtc") {
    if (!channel || !channel.enabled) {
      return reply.code(401).send({ error: "denied" });
    }
    const viewer = verifyViewerAccess(slug, body.token ?? null);
    if (viewer && requestedPath === toWebRtcPath(slug)) {
      return { ok: true };
    }
    return reply.code(401).send({ error: "denied" });
  }

  if (action === "read" && protocol === "hls") {
    if (!requestedPath || isMediaStaticAsset(requestedPath)) {
      return { ok: true };
    }
    if (!channel || !channel.enabled) {
      return reply.code(401).send({ error: "denied" });
    }
    const viewer = verifyViewerAccess(slug, body.token ?? null);
    if (viewer) {
      return { ok: true };
    }
    return reply.code(401).send({ error: "denied" });
  }

  return reply.code(401).send({ error: "denied" });
});

const MEDIA_PROXY_TIMEOUT_MS = 15000;
const MEDIA_FORWARD_HEADERS = [
  "content-type",
  "cache-control",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

async function proxyMediaUpstream(
  reply: any,
  url: string,
  init: { method: string; headers?: Record<string, string> },
) {
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: init.method,
      headers: init.headers,
      signal: AbortSignal.timeout(MEDIA_PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    app.log.error(error, "media upstream request failed");
    return reply.code(502).send("Bad Gateway");
  }

  if (!upstream.ok) {
    return reply.code(upstream.status).send(await upstream.text());
  }

  for (const header of MEDIA_FORWARD_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) {
      reply.header(header, value);
    }
  }
  reply.code(upstream.status);

  const body = upstream.body;
  if (init.method === "HEAD" || !body) {
    return reply.send();
  }
  return reply.send(Readable.fromWeb(body));
}

app.route({
  method: ["GET", "HEAD"],
  url: "/media/*",
  handler: async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];
    const normalizedPath = wildcard.replace(/^\/+/, "");
    const range = request.headers.range;
    const url = `${config.mediaHlsOrigin}/${normalizedPath}`;

    if (isMediaStaticAsset(normalizedPath)) {
      return proxyMediaUpstream(reply, url, {
        method: request.method,
        headers: range ? { range } : undefined,
      });
    }

    const slug = normalizeSlug(toSourceSlug(normalizedPath.split("/")[0] ?? ""));
    const token = getViewerTokenFromRequest(request, slug);
    const channel = verifyViewerAccess(slug, token);
    if (!channel) {
      return reply.code(401).send("Unauthorized");
    }

    return proxyMediaUpstream(reply, url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(range ? { range } : {}),
      },
    });
  },
});

// SPA 前端路由兜底:非 API / 媒体 / WS 的 GET 请求且静态文件未命中时,返回 index.html,
// 交给前端 react-router 决定渲染管理台还是观看页。
const SPA_FALLBACK_EXCLUDE = ["/api", "/media", "/ws", "/internal", "/health"];
app.setNotFoundHandler((request, reply) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return reply.code(404).send({ error: "not-found" });
  }
  if (SPA_FALLBACK_EXCLUDE.some((prefix) => request.url.startsWith(prefix))) {
    return reply.code(404).send({ error: "not-found" });
  }
  return reply.type("text/html; charset=utf-8").sendFile("index.html");
});

app.register(async (wsApp) => {
  await wsApp.register(fastifyWebsocket);

  wsApp.get(
    "/ws/comments",
    { websocket: true },
    async (socket, request) => {
      const url = new URL(request.raw.url ?? "/ws/comments", "http://127.0.0.1");
      const slugParam = url.searchParams.get("channel") ?? "";
      const token = url.searchParams.get("token") ?? "";
      const slug = normalizeSlug(slugParam);
      const channel = verifyViewerAccess(slug, token);
      if (!channel) {
        socket.close(4003, "unauthorized");
        return;
      }

      addViewerSocket(channel.slug, socket);

      socket.on("close", () => {
        removeViewerSocket(channel.slug, socket);
      });

      socket.on("message", (raw: RawData) => {
        let payload: { type?: string; authorName?: string; body?: string };
        try {
          payload = JSON.parse(raw.toString()) as {
            type?: string;
            authorName?: string;
            body?: string;
          };
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "bad-json" }));
          return;
        }

        if (payload.type !== "comment") {
          socket.send(JSON.stringify({ type: "error", message: "bad-type" }));
          return;
        }

        const authorName = trimText(payload.authorName ?? "");
        const body = trimText(payload.body ?? "");

        if (!authorName || authorName.length > 24) {
          socket.send(JSON.stringify({ type: "error", message: "bad-name" }));
          return;
        }
        if (!body || body.length > 200) {
          socket.send(JSON.stringify({ type: "error", message: "bad-body" }));
          return;
        }

        const freshChannel = db.getChannelById(channel.id);
        if (
          !freshChannel ||
          !freshChannel.enabled ||
          freshChannel.authVersion !== channel.authVersion
        ) {
          socket.close(4001, "refresh");
          return;
        }

        const comment = db.addComment(channel.id, authorName, body);
        broadcastComment(channel.slug, comment);
      });

      socket.send(JSON.stringify({ type: "ready" }));
    },
  );
});

app.setErrorHandler(async (error, request, reply) => {
  request.log.error(error);
  if (reply.sent) {
    return;
  }
  reply.code(500).send({
    error: "server-error",
  });
});

async function start(): Promise<void> {
  await syncTranscoders();
  const timer = setInterval(() => {
    void syncTranscoders();
  }, 1500);
  timer.unref();

  const shutdown = () => {
    for (const manager of transcoderManagers) {
      manager.stopAll();
    }
    relayManager.stopAll();
    recorderManager.stopAll();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({
    port: config.appPort,
    host: "0.0.0.0",
  });
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
