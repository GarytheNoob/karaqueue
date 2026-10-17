/**
 * Nikokara Player - background service worker.
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

/** Extract `${bvid}:p${page}` identity from a bilibili watch URL. */
function trackIdentity(url) {
  try {
    const u = new URL(url);
    const bv = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    if (!bv) return null;
    const p = Number(u.searchParams.get("p") || 1);
    return `${bv[1]}:p${p}`;
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
  const tabs = await chrome.tabs.query({ url: "*://*.bilibili.com/video/*" });
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
