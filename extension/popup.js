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

// Show what is currently playing, so the operator can verify connectivity.
async function refresh() {
  try {
    const base = (await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER })).serverUrl;
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/state`);
    const state = await res.json();
    now.textContent = state.current
      ? `正在播放：${state.current.title}（P${state.current.page}）`
      : `空闲中（队列剩 ${state.queue.length} 首；空闲时新提交的歌会自动开始播放）`;
  } catch {
    now.textContent = "无法连接队列服务（检查服务是否运行 / 地址是否正确）";
  }
}
refresh();
