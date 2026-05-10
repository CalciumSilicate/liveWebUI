import { setInterval } from "node:timers";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";
import type { RawData, WebSocket } from "ws";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { AppDatabase } from "./db";
import { MediaService } from "./media";
import { escapeHtml, renderHtmlPage } from "./templates";
import { Channel, CommentView } from "./types";
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
  };
}

const config = loadConfig();
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

const transcoderManagers = [
  hlsTranscoder,
  webrtcTranscoder,
];

function stopTranscodersForSlug(slug: string): void {
  for (const manager of transcoderManagers) {
    manager.stop(slug);
  }
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

async function channelStatusMap(): Promise<Map<string, { online: boolean; readers: number }>> {
  try {
    const items = await media.listPaths();
    const map = new Map<string, { online: boolean; readers: number }>();
    for (const item of items) {
      map.set(item.name, {
        online: item.online,
        readers: item.readers?.length ?? 0,
      });
    }
    return map;
  } catch (error) {
    app.log.error(error, "failed to load MediaMTX paths");
    return new Map();
  }
}

async function syncTranscoders(): Promise<void> {
  try {
    const channels = db.listChannels();
    const paths = await media.listPaths();
    for (const manager of transcoderManagers) {
      manager.sync(channels, paths);
    }
  } catch (error) {
    app.log.error(error, "failed to sync browser transcoders");
  }
}

function adminPage(): string {
  return renderHtmlPage({
    title: "后台",
    bodyClass: "admin-shell",
    scriptPath: "/assets/admin.js",
    body: `
      <main class="page admin-page">
        <section class="panel admin-login" id="login-panel">
          <h1>后台</h1>
          <form id="login-form" class="stack tight">
            <label class="sr-only" for="login-password">密码</label>
            <input class="sr-only" name="username" type="text" autocomplete="username" value="admin" tabindex="-1" aria-hidden="true" readonly />
            <input class="ui-input" id="login-password" name="password" type="password" placeholder="密码" autocomplete="current-password" />
            <button class="ui-button" type="submit">进</button>
          </form>
          <p class="error" id="login-error" hidden></p>
        </section>

        <section class="panel admin-app" id="admin-panel" hidden>
          <header class="admin-head">
            <h1>渠道</h1>
            <div class="head-actions">
              <button class="ui-button" id="refresh-button" type="button">刷新</button>
              <button class="ui-button" id="logout-button" type="button">退</button>
            </div>
          </header>

          <form id="create-form" class="channel-form grid-form">
            <label class="sr-only" for="create-label">名称</label>
            <input class="ui-input" id="create-label" name="label" type="text" placeholder="名称" maxlength="40" required />
            <label class="sr-only" for="create-slug">slug</label>
            <input class="ui-input" id="create-slug" name="slug" type="text" placeholder="slug" maxlength="32" required />
            <label class="sr-only" for="create-publish-password">推流码</label>
            <input class="ui-input" id="create-publish-password" name="publishPassword" type="text" placeholder="推流码" maxlength="64" required />
            <label class="sr-only" for="create-viewer-password">观看码</label>
            <input class="ui-input" id="create-viewer-password" name="viewerPassword" type="text" placeholder="观看码" maxlength="64" required />
            <label class="switch-line">
              <input name="enabled" type="checkbox" checked />
              <span>开</span>
            </label>
            <button class="ui-button" type="submit">新建</button>
          </form>

          <p class="error" id="create-error" hidden></p>

          <div id="channels" class="channel-list"></div>
        </section>
      </main>
    `,
  });
}

function watchPage(channel: Channel): string {
  const channelLabel = escapeHtml(channel.label);
  return renderHtmlPage({
    title: channel.label,
    bodyClass: "watch-shell",
    scriptPath: "/assets/watch.js",
    body: `
      <main class="page watch-page" data-slug="${channel.slug}" data-label="${channelLabel}">
        <section class="video-panel">
          <header class="watch-head">
            <h1>${channelLabel}</h1>
            <div class="watch-meta">
              <span class="badge" id="watch-status">离线</span>
              <div class="mode-switch" id="mode-switch">
                <button class="ui-button ui-button-ghost mode-button" data-mode="webrtc" type="button">极速</button>
                <button class="ui-button ui-button-ghost mode-button" data-mode="hls" type="button">兼容</button>
              </div>
            </div>
          </header>
          <div class="player-frame" id="player-frame">
            <video id="player" controls playsinline muted autoplay preload="metadata"></video>
            <div class="player-cover" id="player-cover">离线</div>
          </div>
          <p class="player-note" id="player-note" hidden></p>
          <section class="access-panel panel" id="access-panel">
            <form id="access-form" class="stack tight">
              <label class="sr-only" for="viewer-password">观看码</label>
              <input class="sr-only" name="username" type="text" autocomplete="username" value="${channel.slug}" tabindex="-1" aria-hidden="true" readonly />
              <input class="ui-input" id="viewer-password" type="password" placeholder="观看码" autocomplete="current-password" />
              <button class="ui-button" type="submit">进入</button>
            </form>
            <p class="error" id="access-error" hidden></p>
          </section>
        </section>

        <aside class="chat-panel panel">
          <div class="chat-head">
            <label class="sr-only" for="author-name">名字</label>
            <input class="ui-input" id="author-name" type="text" placeholder="名字" maxlength="24" />
          </div>
          <div id="comments" class="comments"></div>
          <form id="comment-form" class="comment-form">
            <label class="sr-only" for="comment-body">评论</label>
            <textarea class="ui-textarea" id="comment-body" rows="3" maxlength="200" placeholder="评论"></textarea>
            <button class="ui-button" type="submit">发</button>
          </form>
          <p class="error" id="comment-error" hidden></p>
        </aside>
      </main>
    `,
  });
}

app.register(fastifyCookie);
app.register(fastifyStatic, {
  root: join(process.cwd(), "public"),
  prefix: "/assets/",
});

app.get("/health", async () => ({
  ok: true,
}));

app.get("/", async (_, reply) => {
  reply.redirect("/admin");
});

app.get("/admin", async (_, reply) => {
  reply.type("text/html; charset=utf-8").send(adminPage());
});

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
    };
  });
});

app.post("/api/admin/channels", async (request, reply) => {
  const body = request.body as {
    slug?: string;
    label?: string;
    publishPassword?: string;
    viewerPassword?: string;
    enabled?: boolean;
  };

  const slug = normalizeSlug(body?.slug ?? "");
  const label = trimText(body?.label ?? "");
  const publishPassword = body?.publishPassword ?? "";
  const viewerPassword = body?.viewerPassword ?? "";
  const enabled = body?.enabled !== false;

  if (!validateSlug(slug)) {
    return reply.code(400).send({ error: "slug 需为 3-32 位小写字母、数字或 -" });
  }
  if (!label) {
    return reply.code(400).send({ error: "名称不能为空" });
  }
  if (!publishPassword || !viewerPassword) {
    return reply.code(400).send({ error: "密码不能为空" });
  }

  try {
    const channel = db.createChannel({
      slug,
      label,
      publishPassword,
      viewerPassword,
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
  };

  const input: {
    slug?: string;
    label?: string;
    publishPassword?: string;
    viewerPassword?: string;
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

  try {
    const { before, after } = db.updateChannel(channelId, input);
    if (
      before.slug !== after.slug ||
      before.viewerPassword !== after.viewerPassword
    ) {
      disconnectViewerSockets(before.slug);
      stopTranscodersForSlug(before.slug);
      if (before.slug !== after.slug) {
        try {
          await media.kickChannelPublishers(before.slug);
        } catch (error) {
          request.log.error(error, "failed to kick publishers after slug change");
        }
      }
    }
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
  try {
    await media.kickChannelPublishers(channel.slug);
  } catch (error) {
    request.log.error(error, "failed to kick publishers on delete");
  }
  return { ok: true };
});

app.get("/watch/:slug", async (request, reply) => {
  const slug = normalizeSlug((request.params as { slug: string }).slug);
  const channel = db.getChannelBySlug(slug);
  if (!channel) {
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  }
  reply.type("text/html; charset=utf-8").send(watchPage(channel));
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

  await syncTranscoders();
  const pathMap = await channelStatusMap();
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

  await syncTranscoders();
  const pathMap = await channelStatusMap();
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

const HLS_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.6.13/hls.min.js";

app.route({
  method: ["GET", "HEAD"],
  url: "/media/hls.min.js",
  handler: async (_, reply) => {
    reply.redirect(HLS_JS_CDN);
  },
});

app.get("/media/*", async (request, reply) => {
  const wildcard = (request.params as { "*": string })["*"];
  const normalizedPath = wildcard.replace(/^\/+/, "");
  if (isMediaStaticAsset(normalizedPath)) {
    const assetResponse = await fetch(`${config.mediaHlsOrigin}/${normalizedPath}`);
    if (!assetResponse.ok) {
      return reply.code(assetResponse.status).send(await assetResponse.text());
    }

    const contentType = assetResponse.headers.get("content-type");
    if (contentType) {
      reply.header("content-type", contentType);
    }
    const cacheControl = assetResponse.headers.get("cache-control");
    if (cacheControl) {
      reply.header("cache-control", cacheControl);
    }

    const body = assetResponse.body;
    if (!body) {
      return reply.code(204).send();
    }

    return reply.send(Readable.fromWeb(body));
  }

  const slug = normalizeSlug(toSourceSlug(normalizedPath.split("/")[0] ?? ""));
  const token = getViewerTokenFromRequest(request, slug);
  const channel = verifyViewerAccess(slug, token);

  if (!channel) {
    return reply.code(401).send("Unauthorized");
  }

  const upstream = await fetch(`${config.mediaHlsOrigin}/${normalizedPath}`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (!upstream.ok) {
    return reply.code(upstream.status).send(await upstream.text());
  }

  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    reply.header("content-type", contentType);
  }
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) {
    reply.header("cache-control", cacheControl);
  }

  const body = upstream.body;
  if (!body) {
    return reply.code(204).send();
  }

  return reply.send(Readable.fromWeb(body));
});

app.get("/favicon.ico", async (_, reply) => {
  reply.code(204).send();
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

  process.on("SIGTERM", () => {
    for (const manager of transcoderManagers) {
      manager.stopAll();
    }
  });
  process.on("SIGINT", () => {
    for (const manager of transcoderManagers) {
      manager.stopAll();
    }
  });

  await app.listen({
    port: config.appPort,
    host: "0.0.0.0",
  });
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
