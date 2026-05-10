const root = document.querySelector(".watch-page");
const slug = root?.dataset.slug || "";
const accessForm = document.getElementById("access-form");
const accessPanel = document.getElementById("access-panel");
const accessError = document.getElementById("access-error");
const statusNode = document.getElementById("watch-status");
const noteNode = document.getElementById("player-note");
const commentError = document.getElementById("comment-error");
const commentsRoot = document.getElementById("comments");
const commentForm = document.getElementById("comment-form");
const authorInput = document.getElementById("author-name");
const commentBody = document.getElementById("comment-body");
const player = document.getElementById("player");
const playerCover = document.getElementById("player-cover");
const modeButtons = Array.from(document.querySelectorAll(".mode-button"));
const commentSubmit = commentForm?.querySelector('button[type="submit"]');
const authorPlaceholder = authorInput?.getAttribute("placeholder") || "";
const commentPlaceholder = commentBody?.getAttribute("placeholder") || "";

let viewerToken = sessionStorage.getItem(`viewer:${slug}`) || "";
let ws = null;
let channelState = null;
let currentMode = "";
let preferredMode = localStorage.getItem(`live-server:mode:${slug}`) || "webrtc";
let isComposingComment = false;
let hlsPlayer = null;
let rtcReader = null;
let playbackGeneration = 0;
let fallbackTimer = null;
let scriptPromises = new Map();

function showError(node, message) {
  if (!node) return;
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.textContent = message;
}

function setNote(message) {
  if (!noteNode) return;
  if (!message) {
    noteNode.hidden = true;
    noteNode.textContent = "";
    return;
  }
  noteNode.hidden = false;
  noteNode.textContent = message;
}

function setStatus(channel) {
  const sourceOnline = Boolean(channel?.sourceOnline);
  if (statusNode) {
    statusNode.textContent = sourceOnline ? "在线" : "离线";
    statusNode.className = sourceOnline ? "badge live" : "badge off";
  }
  if (playerCover) {
    playerCover.hidden = sourceOnline;
    playerCover.textContent = sourceOnline ? "" : "未直播";
  }
}

function updateModeButtons(channel) {
  for (const button of modeButtons) {
    const mode = button.dataset.mode;
    const isActive = mode === currentMode;
    const available = Boolean(channel?.modes?.[mode]?.available);
    button.classList.toggle("is-active", isActive);
    button.disabled = !available;
  }
}

function cleanupPlayback() {
  playbackGeneration += 1;

  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }

  if (rtcReader) {
    rtcReader.close();
    rtcReader = null;
  }

  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  if (player instanceof HTMLVideoElement) {
    player.pause();
    player.srcObject = null;
    player.removeAttribute("src");
    player.load();
    player.muted = true;
  }
}

function disconnectComments() {
  if (!ws) {
    return;
  }
  const socket = ws;
  ws = null;
  socket.close();
}

function setCommentUiAuthorized(isAuthorized) {
  if (commentsRoot) {
    commentsRoot.hidden = !isAuthorized;
    if (!isAuthorized) {
      commentsRoot.innerHTML = "";
    }
  }

  if (authorInput) {
    authorInput.disabled = !isAuthorized;
    authorInput.placeholder = isAuthorized ? authorPlaceholder : "请先输入观看码";
  }
  if (commentBody) {
    commentBody.disabled = !isAuthorized;
    commentBody.placeholder = isAuthorized ? commentPlaceholder : "请先输入观看码";
  }
  if (commentSubmit) {
    commentSubmit.disabled = !isAuthorized;
  }

  commentForm?.classList.toggle("is-disabled", !isAuthorized);
}

function applyViewerAccessState(isAuthorized) {
  if (accessPanel) {
    accessPanel.hidden = isAuthorized;
  }
  setCommentUiAuthorized(isAuthorized);
  if (!isAuthorized) {
    updateModeButtons(null);
    showError(commentError, "");
  }
}

function resetViewerAccess(message = "请重新进入") {
  sessionStorage.removeItem(`viewer:${slug}`);
  viewerToken = "";
  channelState = null;
  currentMode = "";
  disconnectComments();
  cleanupPlayback();
  setStatus({ sourceOnline: false });
  updateModeButtons(null);
  applyViewerAccessState(false);
  showError(accessError, message);
}

function hasActivePlayback() {
  return Boolean(rtcReader || hlsPlayer || player?.srcObject || player?.getAttribute("src"));
}

function loadScript(src) {
  if (scriptPromises.has(src)) {
    return scriptPromises.get(src);
  }

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`load failed: ${src}`));
    document.head.append(script);
  });

  scriptPromises.set(src, promise);
  return promise;
}

async function ensureHlsJs() {
  if (window.Hls) {
    return;
  }
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.6.13/hls.min.js");
}

async function ensureWebRtcReader() {
  if (window.MediaMTXWebRTCReader) {
    return;
  }
  await loadScript("/assets/reader.js");
}

async function tryPlay() {
  if (!(player instanceof HTMLVideoElement)) {
    return;
  }
  const promise = player.play();
  if (promise && typeof promise.catch === "function") {
    await promise.catch(() => {});
  }
}

function resolveMode(channel) {
  if (preferredMode === "webrtc" && channel.modes.webrtc.available) {
    return "webrtc";
  }
  if (preferredMode === "hls" && channel.modes.hls.available) {
    return "hls";
  }
  return channel.defaultMode || (channel.modes.webrtc.available ? "webrtc" : "hls");
}

async function startHls(channel, generation) {
  if (!(player instanceof HTMLVideoElement)) {
    return;
  }

  const playlistUrl = channel.modes.hls.playlistUrl;
  if (!playlistUrl) {
    setNote("兼容不可用");
    return;
  }

  await ensureHlsJs();
  if (generation !== playbackGeneration) {
    return;
  }

  setNote("");

  if (player.canPlayType("application/vnd.apple.mpegurl")) {
    player.src = playlistUrl;
    player.addEventListener(
      "loadedmetadata",
      () => {
        if (generation === playbackGeneration) {
          void tryPlay();
        }
      },
      { once: true },
    );
    return;
  }

  if (!window.Hls?.isSupported()) {
    setNote("兼容不可用");
    return;
  }

  hlsPlayer = new window.Hls({
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 4,
    maxBufferLength: 2,
    backBufferLength: 10,
    enableWorker: true,
    xhrSetup(xhr) {
      xhr.setRequestHeader("Authorization", `Bearer ${viewerToken}`);
    },
  });

  hlsPlayer.on(window.Hls.Events.ERROR, (_, data) => {
    if (generation !== playbackGeneration) {
      return;
    }
    if (data?.fatal) {
      setNote("兼容异常");
    }
  });

  hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, () => {
    if (generation === playbackGeneration) {
      void tryPlay();
    }
  });

  hlsPlayer.loadSource(playlistUrl);
  hlsPlayer.attachMedia(player);
}

async function startWebRtc(channel, generation) {
  if (!(player instanceof HTMLVideoElement)) {
    return;
  }

  await ensureWebRtcReader();
  if (generation !== playbackGeneration) {
    return;
  }

  setNote("极速连接中");

  let trackSeen = false;
  const fallback = () => {
    if (generation !== playbackGeneration || currentMode !== "webrtc") {
      return;
    }
    setNote("已切兼容");
    void activateMode("hls", { persist: false });
  };

  fallbackTimer = window.setTimeout(() => {
    if (!trackSeen) {
      fallback();
    }
  }, 3500);

  const fallbackStream = new MediaStream();

  rtcReader = new window.MediaMTXWebRTCReader({
    url: channel.modes.webrtc.whepUrl,
    token: viewerToken,
    onError: (err) => {
      if (generation !== playbackGeneration || currentMode !== "webrtc") {
        return;
      }
      console.error(err);
      if (!trackSeen) {
        fallback();
      } else {
        setNote("极速波动");
      }
    },
    onTrack: (evt) => {
      if (generation !== playbackGeneration) {
        return;
      }

      trackSeen = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }

      if (evt.streams && evt.streams[0]) {
        player.srcObject = evt.streams[0];
      } else {
        fallbackStream.addTrack(evt.track);
        player.srcObject = fallbackStream;
      }

      setNote("");
      void tryPlay();
    },
  });
}

async function activateMode(mode, options = { persist: true }) {
  if (!channelState) {
    return;
  }

  currentMode = mode;
  if (options.persist) {
    preferredMode = mode;
    localStorage.setItem(`live-server:mode:${slug}`, mode);
  }

  updateModeButtons(channelState);
  cleanupPlayback();

  if (!channelState.sourceOnline) {
    setNote("");
    return;
  }

  const generation = playbackGeneration;
  if (mode === "webrtc" && channelState.modes.webrtc.available) {
    await startWebRtc(channelState, generation);
    return;
  }

  if (channelState.modes.hls.available) {
    await startHls(channelState, generation);
    return;
  }

  setNote("不可用");
}

function renderComment(comment) {
  const item = document.createElement("article");
  item.className = "comment";

  const head = document.createElement("div");
  head.className = "comment-head";

  const author = document.createElement("strong");
  author.textContent = comment.authorName;

  const time = document.createElement("span");
  time.textContent = new Date(comment.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  head.append(author, time);

  const body = document.createElement("div");
  body.className = "comment-body";
  body.textContent = comment.body;

  item.append(head, body);
  return item;
}

function fillComments(comments) {
  if (!commentsRoot) {
    return;
  }
  commentsRoot.innerHTML = "";
  (Array.isArray(comments) ? comments : []).forEach((comment) => {
    commentsRoot.append(renderComment(comment));
  });
  commentsRoot.scrollTop = commentsRoot.scrollHeight;
}

function appendComment(comment) {
  if (!commentsRoot) {
    return;
  }
  commentsRoot.append(renderComment(comment));
  commentsRoot.scrollTop = commentsRoot.scrollHeight;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(viewerToken ? { authorization: `Bearer ${viewerToken}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function connectComments() {
  if (!viewerToken || ws) return;
  const url = new URL(`/ws/comments?channel=${encodeURIComponent(slug)}&token=${encodeURIComponent(viewerToken)}`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  ws = socket;

  socket.addEventListener("message", (event) => {
    if (ws !== socket || !viewerToken) {
      return;
    }
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "comment") {
        appendComment(payload.comment);
      }
      if (payload.type === "error") {
        showError(commentError, "发送失败");
      }
    } catch {
      showError(commentError, "连接异常");
    }
  });

  socket.addEventListener("close", (event) => {
    const wasActiveSocket = ws === socket;
    if (wasActiveSocket) {
      ws = null;
    }
    if (!wasActiveSocket || !viewerToken) {
      return;
    }

    const message = event.code === 4001 || event.code === 4003 ? "请重新进入" : "评论连接已断开，请重新进入";
    resetViewerAccess(message);
  });
}

async function refreshChannel() {
  if (!viewerToken) return;
  try {
    const channel = await api(`/api/public/channels/${slug}`);
    channelState = channel;
    setStatus(channel);
    updateModeButtons(channel);

    if (!channel.sourceOnline) {
      cleanupPlayback();
      setNote("");
    } else {
      const resolvedMode = resolveMode(channel);
      if (!hasActivePlayback() || currentMode !== resolvedMode) {
        currentMode = resolvedMode;
        await activateMode(currentMode, { persist: false });
      }
    }

    if (!ws) {
      connectComments();
    }
  } catch (error) {
    resetViewerAccess(error.message);
  }
}

async function loadComments() {
  if (!viewerToken) return;
  try {
    const comments = await api(`/api/public/channels/${slug}/comments`);
    fillComments(comments);
  } catch (error) {
    resetViewerAccess(error.message);
  }
}

accessForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("viewer-password")?.value || "";
  showError(accessError, "");

  try {
    const result = await api(`/api/public/channels/${slug}/access`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
    viewerToken = result.token;
    sessionStorage.setItem(`viewer:${slug}`, viewerToken);
    channelState = result.channel;
    applyViewerAccessState(true);
    setStatus(result.channel);
    updateModeButtons(result.channel);
    currentMode = resolveMode(result.channel);
    await activateMode(currentMode, { persist: false });
    await loadComments();
    connectComments();
    accessForm.reset();
  } catch (error) {
    resetViewerAccess(error.message);
    showError(accessError, error.message);
  }
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!viewerToken) {
      showError(accessError, "请先输入观看码");
      return;
    }
    const mode = button.dataset.mode;
    if (!mode) return;
    void activateMode(mode, { persist: true });
  });
});

commentForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!viewerToken) {
    applyViewerAccessState(false);
    showError(commentError, "请先输入观看码");
    showError(accessError, "请先输入观看码");
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const message = ws?.readyState === WebSocket.CONNECTING ? "评论连接中，请稍后" : "评论未连接，请重新进入";
    showError(commentError, message);
    return;
  }
  const authorName = (authorInput?.value || "").trim();
  const body = (commentBody?.value || "").trim();
  if (!authorName || !body) {
    showError(commentError, "名字和评论不能为空");
    return;
  }

  localStorage.setItem("live-server:author", authorName);
  ws.send(
    JSON.stringify({
      type: "comment",
      authorName,
      body,
    }),
  );
  if (commentBody) {
    commentBody.value = "";
  }
  showError(commentError, "");
});

commentBody?.addEventListener("compositionstart", () => {
  isComposingComment = true;
});

commentBody?.addEventListener("compositionend", () => {
  isComposingComment = false;
});

commentBody?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  if (event.shiftKey || event.isComposing || isComposingComment) {
    return;
  }

  event.preventDefault();
  commentForm?.requestSubmit();
});

const savedAuthor = localStorage.getItem("live-server:author");
if (savedAuthor && authorInput) {
  authorInput.value = savedAuthor;
}

if (viewerToken) {
  applyViewerAccessState(true);
  void refreshChannel().then(loadComments);
} else {
  applyViewerAccessState(false);
}

setInterval(() => {
  void refreshChannel();
}, 5000);
