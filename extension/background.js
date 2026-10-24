/**
 * KaraQueue - background service worker.
 *
 * Responsibilities:
 *  - Periodically reconcile the playing tab with the server's `current` item
 *    (covers remote skip/advance triggered from the phone UI). One tab is
 *    remembered and reused across reconciles; new tabs are only created
 *    when no candidate exists at all.
 *  - On VIDEO_ENDED (from the content script), verify the report against
 *    the server's current item, advance the queue, navigate the tab and
 *    ack the sender (which retries until it gets the ack).
 *  - OPEN_CURRENT (from the popup) opens or points a tab at the current item.
 *
 * Runs as a service worker on Chromium and as an MV3 event page on Firefox.
 * Event pages (like service workers) may be torn down between events, so
 * all debounce/cooldown state lives in `storage.session`, not in globals.
 */
const DEFAULT_SERVER = "http://127.0.0.1:7777";

/** Ignore duplicate end events arriving within this window. */
const ADVANCE_DEBOUNCE_MS = 4000;

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

// Watch pages first, then any page of the two platforms: the strict
// watch-path patterns can miss a tab for seconds at a time (redirects,
// consent pages), and driving a stray tab beats spawning a new one.
const WATCH_URLS = [
  "*://*.bilibili.com/video/*",
  "*://*.youtube.com/watch*",
  "*://*.youtube.com/shorts*",
  "*://youtu.be/*",
];
const SITE_URLS = ["*://*.bilibili.com/*", "*://*.youtube.com/*", "*://youtu.be/*"];

/** Remember which tab we drive so later reconciles always reuse it,
 * even when its URL is momentarily something unmatchable. */
async function rememberPlayerTab(tabId) {
  if (tabId) await chrome.storage.session.set({ playerTabId: tabId });
}

/** Minimum spacing between tab creations, so no pathology (a dead
 * remembered ID plus a racing query) can ever spam the tab bar. */
const TAB_CREATE_COOLDOWN_MS = 30000;

async function findPlayerTab() {
  const watch = await chrome.tabs.query({ url: WATCH_URLS });
  if (watch[0]) return watch[0];
  const anySite = await chrome.tabs.query({ url: SITE_URLS });
  return anySite[0] ?? null;
}

/**
 * Make sure some tab shows the server's current item. Returns the tab that
 * is now playing (or null if there is nothing to play).
 */
async function reconcile(preferredTabId) {
  const { current } = await getState();
  if (!current) return null;

  // Collect every candidate exactly once, in priority order: the tab
  // this call prefers, the tab we drove last, then pattern matches.
  const candidates = [];
  const push = (tab) => {
    if (tab?.id && !candidates.some((t) => t.id === tab.id)) candidates.push(tab);
  };
  if (preferredTabId) push(await chrome.tabs.get(preferredTabId).catch(() => null));
  const { playerTabId } = await chrome.storage.session.get("playerTabId");
  if (playerTabId) push(await chrome.tabs.get(playerTabId).catch(() => null));
  (await chrome.tabs.query({ url: WATCH_URLS })).slice(0, 5).forEach(push);
  (await chrome.tabs.query({ url: SITE_URLS })).slice(0, 5).forEach(push);

  // Best first: a tab that already plays the right track; else the one
  // we drove last (it may be mid-redirect or on an error page, but
  // navigating it is still the cheapest fix and spawns nothing).
  const tab = candidates.find((t) => t.url && trackIdentity(t.url) === current.id) ?? candidates.find((t) => t.url) ?? null;

  if (!tab) {
    // Nothing usable anywhere: one fresh background tab, remembered.
    const now = Date.now();
    const { lastTabCreateAt = 0 } = await chrome.storage.session.get("lastTabCreateAt");
    if (now - lastTabCreateAt < TAB_CREATE_COOLDOWN_MS) {
      console.log(`[karaqueue] player tab missing, but one was created ${Math.round((now - lastTabCreateAt) / 1000)}s ago; not spawning again yet`);
      return null;
    }
    await chrome.storage.session.set({ lastTabCreateAt: now });
    const created = await chrome.tabs.create({ url: current.web_url, active: false });
    await rememberPlayerTab(created.id);
    console.log(`[karaqueue] no player tab on either platform; created background tab ${created.id} for ${current.id}`);
    return null;
  }

  await rememberPlayerTab(tab.id);
  if (trackIdentity(tab.url) === current.id) {
    console.log(`[karaqueue] tab ${tab.id} already playing ${current.id}`);
    return tab;
  }
  console.log(`[karaqueue] pointing tab ${tab.id} (${String(tab.url).slice(0, 70)}) at ${current.id}`);
  await chrome.tabs.update(tab.id, { url: current.web_url });
  return tab;
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "VIDEO_ENDED") {
    handleEnded(msg, sender.tab?.id)
      .then((res) => sendResponse(res ?? { ok: true }))
      .catch((e) => {
        console.error("[karaqueue] ended hand-off failed:", e);
        sendResponse({ ok: false, error: String(e?.message ?? e) });
      });
    return true; // keep the channel open for the async ack
  }
  if (msg?.type === "OPEN_CURRENT") reconcile(null);
  return false;
});

/**
 * The player finished a track. Verify the report before advancing: a
 * duplicate or stale report (retry after a lost ack, a second tab, the
 * player's own autonav) must not skip the queue. Then point the
 * reporting tab at the promoted track and ack the content script, which
 * retries until confirmed.
 */
async function handleEnded(msg, tabId) {
  const { current } = await getState();
  // The reporting tab says which URL it is on; a mismatch means this
  // report is old or foreign and the queue already moved on.
  const reported = msg.href ? (trackIdentity(msg.href) ?? null) : null;
  if (reported && current && reported !== current.id) {
    console.log(`[karaqueue] ignoring stale ended report for ${reported}; current is ${current.id}`);
    return { ok: true, current: current.id };
  }

  const now = Date.now();
  const { lastAdvanceAt = 0 } = await chrome.storage.session.get("lastAdvanceAt");
  if (now - lastAdvanceAt < ADVANCE_DEBOUNCE_MS) {
    console.log(`[karaqueue] advance debounced, treating ${reported ?? "(unknown track)"} as handled`);
    return { ok: true, current: current?.id ?? null };
  }
  await chrome.storage.session.set({ lastAdvanceAt: now });

  const result = await advance("played");
  const next = result.current;
  console.log(`[karaqueue] advanced: ${result.finished?.id ?? "(none)"} -> ${next?.id ?? "(now idle)"}`);
  if (!next || !tabId) return { ok: true, current: next?.id ?? null };

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url && trackIdentity(tab.url) === next.id) {
    console.log(`[karaqueue] tab ${tabId} already on ${next.id}`);
    return { ok: true, current: next.id };
  }
  await chrome.tabs.update(tabId, { url: next.web_url });
  console.log(`[karaqueue] navigated tab ${tabId} to ${next.id}`);
  return { ok: true, current: next.id };
}

// Periodic reconciliation also catches skips issued from the phone UI.
// 15s on Chromium; Firefox clamps periods under 1 minute up to 1 minute.
// Either way this is only the fallback: message-driven reconcile (open /
// ended) reacts immediately.
chrome.alarms.create("sync", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") reconcile(null).catch(console.error);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("sync", { periodInMinutes: 0.25 });
});
