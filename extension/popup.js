/* Popup: configure the queue server address and open the current track. */
const DEFAULT_SERVER = "http://127.0.0.1:7777";
const input = document.getElementById("serverUrl");
const status = document.getElementById("status");
const now = document.getElementById("now");

chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER }).then(({ serverUrl }) => {
  input.value = serverUrl;
});

document.getElementById("save").addEventListener("click", async () => {
  const url = input.value.trim().replace(/\/+$/, "");
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

// Show what is currently playing and what comes next.
async function refresh() {
  try {
    const base = (await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER })).serverUrl;
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/state`);
    const state = await res.json();
    now.textContent = state.current
      ? `正在播放：${state.current.title}（P${state.current.page}）`
      : `空闲中（队列剩 ${state.queue.length} 首；空闲时新提交的歌会自动开始播放）`;
    const next = state.queue[0];
    document.getElementById("next").textContent = next
      ? `下一首：${next.title}${next.page_count > 1 ? `（P${next.page}）` : ""} — by ${next.requested_by}`
      : state.current ? "下一首：（队列空，播完这首就收工）" : "";
  } catch {
    now.textContent = "无法连接队列服务（检查服务是否运行 / 地址是否正确）";
  }
}
refresh();
