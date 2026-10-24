/* Popup: configure the queue server address, control playback, and mirror
   the now/next state in the same setlist language as the server pages. */
const DEFAULT_SERVER = "http://127.0.0.1:7777";
const status = document.getElementById("status");

/** Fetch and parse JSON with a human-readable failure message. */
async function fetchJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    // Network-level failure: nothing answered (server down / wrong address).
    throw new Error("无法连接到队列服务（服务是否在运行？地址是否可达？）");
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // HTML came back: almost always a wrong address, e.g. missing the
    // :7777 port or a device's own web UI (router page) at that address.
    throw new Error("该地址返回的不是 KaraQueue 数据（JSON），请检查地址是否带上 :7777 端口、且指向运行服务的那台电脑");
  }
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/* Action feedback is a dot + one line, like the server's toasts. */
let statusTimer;
function setStatus(text, tone = "") {
  clearTimeout(statusTimer);
  status.textContent = text;
  status.className = "status" + (tone ? " " + tone : "");
  if (tone === "ok") {
    statusTimer = setTimeout(() => {
      status.textContent = "";
      status.className = "status";
    }, 2500);
  }
}

/* Host access: Chromium grants manifest host_permissions at install, so a
   request() for an already-granted origin answers true with no prompt.
   Firefox keeps host access revocable (and gates content script injection
   on the same grants), so on Firefox we also cover the player sites; the
   door hanger only appears when a grant is actually missing. */
const SERVER_ORIGIN = "http://*/*";
const SITE_ORIGINS = ["*://*.bilibili.com/*", "*://*.youtube.com/*", "*://youtu.be/*"];
const isFirefox = chrome.runtime.getURL("").startsWith("moz-extension:");

/** Ask for every origin this popup needs. Must be awaited within the click
 * (transient user activation). Saves still happen on a refusal; the status
 * just says access is missing. */
async function ensureHostAccess() {
  try {
    return await chrome.permissions.request({
      origins: [SERVER_ORIGIN, ...(isFirefox ? SITE_ORIGINS : [])],
    });
  } catch {
    return false;
  }
}

chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER }).then(({ serverUrl }) => {
  document.getElementById("serverUrl").value = serverUrl;
});

document.getElementById("save").addEventListener("click", async () => {
  const url = document.getElementById("serverUrl").value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) {
    setStatus("地址需要以 http:// 开头", "fail");
    return;
  }
  const granted = await ensureHostAccess();
  await chrome.storage.sync.set({ serverUrl: url });
  if (granted) {
    setStatus("已保存", "ok");
  } else {
    setStatus("已保存，但未获得站点访问权限；再点一次保存重新授权，或在 about:addons 的插件权限里手动开启", "fail");
  }
  await refresh();
});

document.getElementById("open").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_CURRENT" });
  window.close();
});

/* Skip: tell the server to mark the current track as skipped; the server
   promotes the next queued item, then we ask the background worker to
   reconcile immediately so the big screen switches without waiting for
   the periodic alarm. */
document.getElementById("skip").addEventListener("click", async () => {
  setStatus("跳过中…", "busy");
  try {
    const base = (await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER })).serverUrl.replace(/\/+$/, "");
    await fetchJson(`${base}/api/skip`, { method: "POST" });
    await chrome.runtime.sendMessage({ type: "OPEN_CURRENT" });
    setStatus("已跳过", "ok");
  } catch (err) {
    setStatus("跳过失败：" + err.message, "fail");
  }
  await refresh();
});

/* ------------------------------------------------------------------ */
/* Now / next rendering                                               */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDur(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/* One line in the running order: title, requester, duration. */
function titleOf(item) {
  return String(item.title ?? "") + (item.title_missing ? "（元数据未获取）" : "");
}

function partOf(item) {
  return item.page_count > 1 ? ` · P${item.page}` : "";
}

function nowCard(item) {
  return `<div class="now-title">${esc(titleOf(item))}${partOf(item)}</div>
    <div class="now-meta">
      <span class="by">点歌人：${esc(item.requested_by)}</span>
      <span class="dur">${item.duration_s ? fmtDur(item.duration_s) : ""}</span>
    </div>`;
}

function nextRow(item) {
  return `<div class="next-row">
    <div class="next-main">
      <div class="next-title">${esc(titleOf(item))}${partOf(item)}</div>
      <div class="next-meta">点歌人：${esc(item.requested_by)}</div>
    </div>
    <span class="next-dur">${item.duration_s ? fmtDur(item.duration_s) : ""}</span>
  </div>`;
}

const emptyLine = (text) => `<p class="empty">${text}</p>`;

async function refresh() {
  const now = document.getElementById("now");
  const next = document.getElementById("next");
  const nextSec = document.getElementById("nextSec");
  let state;
  try {
    const base = (await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER })).serverUrl.replace(/\/+$/, "");
    state = await fetchJson(`${base}/api/state`);
  } catch (err) {
    now.innerHTML = emptyLine(esc(err.message));
    next.innerHTML = "";
    nextSec.hidden = true;
    return;
  }

  now.innerHTML = state.current
    ? nowCard(state.current)
    : emptyLine(`空闲中（队列剩 ${state.queue.length} 首；空闲时新提交的歌会自动开始播放）`);

  const upNext = state.queue[0];
  nextSec.hidden = !upNext && !state.current;
  next.innerHTML = upNext
    ? nextRow(upNext)
    : state.current ? emptyLine("队列空，播完这首就收工") : "";
}
refresh();
