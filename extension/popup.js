/* Popup: configure the queue server address, control playback, and mirror
   the card-based track display used by the song request page. */
const DEFAULT_SERVER = "http://127.0.0.1:7777";
const status = document.getElementById("status");

chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER }).then(({ serverUrl }) => {
  document.getElementById("serverUrl").value = serverUrl;
});

document.getElementById("save").addEventListener("click", async () => {
  const url = document.getElementById("serverUrl").value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) {
    status.textContent = "地址需要以 http:// 开头";
    return;
  }
  await chrome.storage.sync.set({ serverUrl: url });
  status.textContent = "已保存 ✓";
  setTimeout(() => (status.textContent = ""), 2000);
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
  status.textContent = "跳过中…";
  try {
    const base = (await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER })).serverUrl.replace(/\/+$/, "");
    await fetch(`${base}/api/skip`, { method: "POST" });
    await chrome.runtime.sendMessage({ type: "OPEN_CURRENT" });
    status.textContent = "已跳过 ✓";
  } catch (err) {
    status.textContent = "跳过失败: " + err;
  }
  await refresh();
});

/* ------------------------------------------------------------------ */
/* Card rendering (same design as the request page)                    */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDur(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function card(item, { tag, tagClass, now }) {
  const part = item.page_count > 1 ? ` · P${item.page}` : "";
  return `<div class="card ${now ? "now" : tagClass ? tagClass : ""}">
    <div class="title"><span class="tag ${tagClass}">${tag}</span>${esc(item.title)}${part ? ` <span style="color:#7ab">· P${item.page}</span>` : ""}</div>
    <div class="meta"><span>点歌人：${esc(item.requested_by)}</span><span>${item.duration_s ? fmtDur(item.duration_s) : ""}</span></div>
  </div>`;
}

const empty = (text) => `<div class="empty">${text}</div>`;

async function refresh() {
  const now = document.getElementById("now");
  const next = document.getElementById("next");
  let state;
  try {
    const base = (await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER })).serverUrl.replace(/\/+$/, "");
    state = await (await fetch(`${base}/api/state`)).json();
  } catch {
    now.innerHTML = empty("无法连接队列服务（检查服务是否运行 / 地址是否正确）");
    next.innerHTML = "";
    return;
  }

  now.innerHTML = state.current
    ? card(state.current, { tag: "NOW", tagClass: "", now: true })
    : empty(`空闲中（队列剩 ${state.queue.length} 首；空闲时新提交的歌会自动开始播放）`);

  const upNext = state.queue[0];
  next.innerHTML = upNext
    ? card(upNext, { tag: "NEXT", tagClass: "upnext", now: false })
    : state.current ? empty("队列空，播完这首就收工") : "";
}
refresh();
