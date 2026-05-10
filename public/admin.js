const loginPanel = document.getElementById("login-panel");
const adminPanel = document.getElementById("admin-panel");
const loginForm = document.getElementById("login-form");
const createForm = document.getElementById("create-form");
const channelsRoot = document.getElementById("channels");
const loginError = document.getElementById("login-error");
const createError = document.getElementById("create-error");
const refreshButton = document.getElementById("refresh-button");
const logoutButton = document.getElementById("logout-button");

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

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
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

async function copyText(value) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) {
    throw new Error("复制失败");
  }
}

function rowTemplate(channel) {
  const statusClass = channel.online ? "badge live" : "badge off";
  const enabledLabel = channel.enabled ? "开" : "关";
  const toggleLabel = channel.enabled ? "停" : "启";
  const sourceClass = channel.sourceOnline ? "badge live" : "badge off";
  const webrtcClass = channel.webrtcOnline ? "badge live" : "badge off";
  const hlsClass = channel.hlsOnline ? "badge live" : "badge off";

  return `
    <article class="channel-card ${channel.enabled ? "" : "is-disabled"}" data-id="${channel.id}">
      <div class="channel-toolbar">
        <span class="${statusClass}">${channel.state}</span>
        <span class="badge">${enabledLabel}</span>
        <span class="badge">${channel.readers} 读</span>
        <div class="channel-state">${channel.slug}</div>
      </div>

      <div class="mode-flags">
        <span class="${sourceClass}">源 ${channel.sourceOnline ? "开" : "停"}</span>
        <span class="${webrtcClass}">快 ${channel.webrtcReaders || 0}</span>
        <span class="${hlsClass}">兼 ${channel.hlsReaders || 0}</span>
      </div>

      <div class="channel-editor">
        <label class="field">
          <span>名称</span>
          <input class="ui-input" data-field="label" type="text" value="${escapeAttr(channel.label)}" maxlength="40" />
        </label>
        <label class="field">
          <span>Slug</span>
          <input class="ui-input" data-field="slug" type="text" value="${escapeAttr(channel.slug)}" maxlength="32" />
        </label>
        <label class="field">
          <span>推流码</span>
          <input class="ui-input" data-field="publishPassword" type="text" value="${escapeAttr(channel.publishPassword)}" maxlength="64" />
        </label>
        <label class="field">
          <span>观看码</span>
          <input class="ui-input" data-field="viewerPassword" type="text" value="${escapeAttr(channel.viewerPassword)}" maxlength="64" />
        </label>
      </div>

      <div class="channel-editor">
        <div class="field">
          <span>推流</span>
          <div class="link-line">
            <div class="mono">${escapeHtml(channel.pushUrl)}</div>
            <button type="button" class="ui-button ui-button-ghost" data-copy="${escapeAttr(channel.pushUrl)}">复制</button>
          </div>
        </div>
        <div class="field">
          <span>观看</span>
          <div class="link-line">
            <div class="mono">${escapeHtml(channel.watchUrl)}</div>
            <button type="button" class="ui-button ui-button-ghost" data-copy="${escapeAttr(channel.watchUrl)}">复制</button>
          </div>
        </div>
      </div>

      <div class="card-actions">
        <button type="button" class="ui-button" data-action="save">保存</button>
        <button type="button" class="ui-button ui-button-ghost" data-action="toggle">${toggleLabel}</button>
        <button type="button" class="ui-button ui-button-warn" data-action="delete">删</button>
      </div>
    </article>
  `;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadChannels() {
  const channels = await requestJson("/api/admin/channels", {
    headers: {},
  });
  channelsRoot.innerHTML = channels.map(rowTemplate).join("");
  loginPanel.hidden = true;
  adminPanel.hidden = false;
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("login-password")?.value || "";
  showError(loginError, "");

  try {
    await requestJson("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    loginForm.reset();
    await loadChannels();
  } catch (error) {
    showError(loginError, error.message);
  }
});

createForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(createForm);
  showError(createError, "");

  const payload = {
    label: String(formData.get("label") || ""),
    slug: String(formData.get("slug") || ""),
    publishPassword: String(formData.get("publishPassword") || ""),
    viewerPassword: String(formData.get("viewerPassword") || ""),
    enabled: formData.get("enabled") === "on",
  };

  try {
    await requestJson("/api/admin/channels", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    createForm.reset();
    createForm.querySelector('input[name="enabled"]').checked = true;
    await loadChannels();
  } catch (error) {
    showError(createError, error.message);
  }
});

channelsRoot?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const copyValue = target.getAttribute("data-copy");
  if (copyValue) {
    try {
      await copyText(copyValue);
      const original = target.textContent;
      target.textContent = "已复制";
      window.setTimeout(() => {
        target.textContent = original;
      }, 1200);
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  const action = target.getAttribute("data-action");
  if (!action) return;

  const card = target.closest(".channel-card");
  if (!(card instanceof HTMLElement)) return;
  const id = card.getAttribute("data-id");
  if (!id) return;

  if (action === "save") {
    const payload = {};
    for (const input of card.querySelectorAll("[data-field]")) {
      if (input instanceof HTMLInputElement) {
        payload[input.dataset.field] = input.value;
      }
    }
    try {
      await requestJson(`/api/admin/channels/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await loadChannels();
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  if (action === "toggle") {
    const enabled = target.textContent === "停";
    try {
      await requestJson(`/api/admin/channels/${id}/${enabled ? "disable" : "enable"}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadChannels();
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  if (action === "delete") {
    const ok = window.confirm("删除？");
    if (!ok) return;
    try {
      await requestJson(`/api/admin/channels/${id}`, {
        method: "DELETE",
      });
      await loadChannels();
    } catch (error) {
      alert(error.message);
    }
  }
});

refreshButton?.addEventListener("click", () => {
  loadChannels().catch((error) => {
    console.error(error);
  });
});

logoutButton?.addEventListener("click", async () => {
  try {
    await requestJson("/api/admin/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } finally {
    adminPanel.hidden = true;
    loginPanel.hidden = false;
  }
});

setInterval(() => {
  if (!adminPanel.hidden) {
    loadChannels().catch((error) => {
      if (String(error.message).includes("未登录")) {
        adminPanel.hidden = true;
        loginPanel.hidden = false;
      }
    });
  }
}, 5000);

loadChannels().catch(() => {
  loginPanel.hidden = false;
  adminPanel.hidden = true;
});
