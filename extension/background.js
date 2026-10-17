/**
 * KaraQueue - background service worker.
 *
 * Responsibilities:
 *  - Periodically reconcile the playing tab with the server's `current` item
 *    (covers remote skip/advance triggered from the phone UI).
 *  - On VIDEO_ENDED (from the content script), tell the server to advance and
 *    navigate the tab to the next track.
 *  - OPEN_CURRENT (from the popup) opens or points a tab at the current item.
 */
const DEFAULT_SERVER = "http://127.0.0.1:7777";

/** Ignore duplicate end events arriving within this window. */
const ADVANCE_DEBOUNCE_MS = 4000;
let lastAdvanceAt = 0;

/* ------------------------------------------------------------------ */
/* Server API helpers                                                  */
/* ------------------------------------------------------------------ */

async function serverUrl() {
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  return serverUrl.replace(/\/+$/, "");
}

async function api(path, options = {}) {
  const base = await serverUrl();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
  return res.json();
}

/** Extract the server's track id from a watch URL (bilibili + youtube). */
function trackIdentity(url) {
  try {
    const u = new URL(url);
    const bv = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    if (bv) {
      const p = Number(u.searchParams.get("p") || 1);
      return `${bv[1]}:p${p}`;
    }
    // YouTube: watch?v=, youtu.be/<id> and shorts all map to <id>:p1,
    // matching the ids the server builds (host is checked so random
    // sites carrying a `v=` query are not mistaken for tracks).
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.split("/")[1] ?? "";
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? `${id}:p1` : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com") {
      const id =
        u.searchParams.get("v") ||
        u.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/)?.[1];
      return id ? `${id}:p1` : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function getState() {
  return api("/api/state");
}

async function advance(mark = "played") {
  return api("/api/advance", { method: "POST", body: JSON.stringify({ mark }) });
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

async function findPlayerTab() {
  const tabs = await chrome.tabs.query({
    url: [
      "*://*.bilibili.com/video/*",
      "*://*.youtube.com/watch*",
      "*://*.youtube.com/shorts*",
      "*://youtu.be/*",
    ],
  });
  return tabs[0] ?? null;
}

/**
 * Make sure some tab shows the server's current item. Returns the tab that
 * is now playing (or null if there is nothing to play).
 */
async function reconcile(preferredTabId) {
  const { current } = await getState();
  if (!current) return null;

  let tab = preferredTabId ? await chrome.tabs.get(preferredTabId).catch(() => null) : null;
  if (!tab || !tab.url) tab = await findPlayerTab();

  if (tab && trackIdentity(tab.url) === current.id) return tab;
  if (tab) {
    await chrome.tabs.update(tab.id, { url: current.web_url });
    return tab;
  }
  // No existing player tab: create one.
  await chrome.tabs.create({ url: current.web_url, active: false });
  return null;
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "VIDEO_ENDED") handleEnded(sender.tab?.id);
  if (msg?.type === "OPEN_CURRENT") reconcile(null);
  // No synchronous response is needed.
  return false;
});

async function handleEnded(tabId) {
  // Debounce: the player may fire `ended` more than once.
  const now = Date.now();
  if (now - lastAdvanceAt < ADVANCE_DEBOUNCE_MS) return;
  lastAdvanceAt = now;

  const result = await advance("played");
  const next = result.current;
  if (!next || !tabId) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // Only navigate when the finished tab differs from the next track
  // (identical BV+P means someone replayed the same track).
  if (!tab || trackIdentity(tab.url) === next.id) return;
  await chrome.tabs.update(tabId, { url: next.web_url });
}

// Periodic reconciliation also catches skips issued from the phone UI.
chrome.alarms.create("sync", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") reconcile(null).catch(console.error);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("sync", { periodInMinutes: 0.25 });
});
