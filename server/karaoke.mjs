#!/usr/bin/env node
/**
 * KaraQueue - queue server (prototype, zero dependencies).
 *
 * Public endpoints (PORT, default 7777):
 *   GET  /                -> song request page (static/index.html)
 *   GET  /api/state       -> full state snapshot
 *   POST /api/submit      -> body { input, by }; resolves input, enqueues it
 *   POST /api/advance     -> mark current as played, promote the next item
 *   POST /api/skip        -> mark current as skipped, promote the next item
 *   GET  /api/events      -> SSE stream; broadcasts full state on every change
 *
 * Admin endpoints (ADMIN_PORT, default 7778; gated by ADMIN_PIN if set):
 *   GET  /                -> admin console (static/admin.html)
 *   GET  /api/state       -> full state snapshot
 *   GET  /api/events      -> SSE stream
 *   GET  /api/config      -> { config }
 *   POST /api/config      -> { allowQueuedDuplicates: boolean }
 *   POST /api/skip        -> skip the current track
 *   POST /api/delete      -> { id }; remove a queued track
 *   POST /api/reorder     -> { id, direction: "up"|"down" }
 *
 * Persistence: server/queue.json (in-memory state, written atomically).
 * Run: node server/karaoke.mjs   (env: PORT, HOST, ADMIN_PORT, ADMIN_PIN)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 7778);
// Optional gate for admin mutations; a PIN is reasonable on shared LANs.
const ADMIN_PIN = process.env.ADMIN_PIN || "";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(ROOT, "static");
const DATA_FILE = path.join(ROOT, "queue.json");

// Realistic browser headers; bilibili's public web API rejects unknown clients.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Tracks are keys by `${platform}:${video_id}:p${page}`. */
const state = {
  current: null,
  queue: [],
  history: [],
  config: { allowQueuedDuplicates: false },
  revision: 0,
};
const DEFAULT_CONFIG = { allowQueuedDuplicates: false };
const sseClients = new Set();

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (raw && Array.isArray(raw.queue)) {
      state.current = raw.current ?? null;
      state.queue = raw.queue ?? [];
      state.history = raw.history ?? [];
      // Merge over defaults so older state files keep working.
      state.config = { ...DEFAULT_CONFIG, ...(raw.config ?? {}) };
      state.revision = raw.revision ?? 0;
      console.log(`[state] restored from ${DATA_FILE}`);
    }
  } catch {
    /* first run or corrupted file: start fresh */
  }
}

function saveState() {
  // Atomic write: write a temp file first, then rename over the target.
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/* ------------------------------------------------------------------ */
/* Track resolution                                                    */
/* ------------------------------------------------------------------ */

const BV_RE = /(BV[0-9A-Za-z]{10})/;
const AID_RE = /av(\d{4,})/i;
const PAGE_RE = /[?&]p=(\d+)/;

/**
 * Parse a user submission (BV id, av id, full URL, b23.tv short link)
 * into { bvid?, aid?, page }.
 */
async function parseInput(rawInput) {
  let input = String(rawInput || "").trim();
  if (!input) throw new Error("empty input");

  // Mobile app share text wraps the link, e.g.
  // "【【纯k投屏】Holiday∞Holiday - ... - 哔哩哔哩】 https://b23.tv/FRuYXW6"
  // Pull the first URL out of arbitrary text before doing anything else.
  const urlMatch = input.match(/https?:\/\/[^\s"'()【】]+/u);
  if (urlMatch) {
    // Drop any CJK/full-width junk the share text may append after the URL.
    input = urlMatch[0].replace(/[^\x21-\x7E]+$/g, "");
  }

  // b23.tv short links are redirects; follow them once to get the real URL.
  if (/b23\.tv/i.test(input)) {
    const res = await fetch(input, {
      headers: { "User-Agent": BROWSER_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    input = res.url;
  }

  // Expand any pasted URL so ids inside query strings are visible.
  if (/^https?:\/\//.test(input)) {
    try {
      const u = new URL(input);
      input = `https://www.bilibili.com${u.pathname}${u.search}`;
    } catch {
      throw new Error("invalid URL");
    }
  }

  const pageMatch = input.match(PAGE_RE);
  const page = pageMatch ? Number(pageMatch[1]) : 1;

  const bv = input.match(BV_RE);
  if (bv) return { bvid: bv[1], page };
  const aid = input.match(AID_RE);
  if (aid) return { aid: aid[1], page };

  throw new Error("no bilibili video id found in input");
}

/** Query bilibili's public web API for video metadata. */
async function fetchView({ bvid, aid }) {
  const qs = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const res = await fetch(`https://api.bilibili.com/x/web-interface/view?${qs}`, {
    headers: { "User-Agent": BROWSER_UA, Referer: "https://www.bilibili.com/" },
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  if (body.code !== 0) {
    const reasons = {
      [-404]: "video not found (deleted or private?)",
      [-412]: "rate limited by bilibili",
    };
    throw new Error(reasons[body.code] ?? `bilibili api code ${body.code}`);
  }
  return body.data;
}

/** Build the canonical queue item from view metadata + page number. */
function makeItem(view, page, requestedBy) {
  const pages = Array.isArray(view.pages) ? view.pages : [];
  // Clamp to the real page range; a bare BV with multi-P defaults to P1.
  const p = pages.length ? Math.min(Math.max(page, 1), pages.length) : 1;
  const part = pages.length ? pages[p - 1]?.part : "";
  const duration = pages.length ? (pages[p - 1]?.duration ?? view.duration) : view.duration;

  return {
    id: `${view.bvid}:p${p}`,
    platform: "bilibili",
    video_id: view.bvid,
    page: p,
    page_count: pages.length,
    title: view.title,
    part,
    uploader: view.owner?.name ?? "",
    duration_s: duration ?? 0,
    thumbnail: view.pic ?? "",
    // Full watch URL including the P parameter, consumed by the extension.
    web_url: `https://www.bilibili.com/video/${view.bvid}${pages.length ? `?p=${p}` : ""}`,
    requested_by: requestedBy || "anonymous",
    requested_at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Queue operations                                                    */
/* ------------------------------------------------------------------ */

/**
 * Find an in-flight duplicate. Behavior depends on the admin config:
 *  - the currently playing track is always rejected;
 *  - tracks already queued are rejected unless the admin allowed that
 *    (then everybody may pile the same song into the queue).
 * Played history is deliberately NOT checked: re-requesting a played
 * track is always allowed.
 */
function findInQueue(item) {
  if (state.current?.id === item.id) return state.current;
  if (state.config.allowQueuedDuplicates) return null;
  return state.queue.find((i) => i.id === item.id);
}

function enqueue(item) {
  state.queue.push(item);
  state.revision += 1;
  saveState();
  broadcast();
}

/** Finish the current item (played|skipped) and promote the next one. */
function advance(mark = "played") {
  const finished = state.current ? { ...state.current, status: mark, finished_at: new Date().toISOString() } : null;
  if (finished) {
    state.history.unshift(finished);
  }
  state.current = state.queue.shift() ?? null;
  if (state.current) state.current.status = "playing";
  state.revision += 1;
  saveState();
  broadcast();
  return { finished: finished, current: state.current };
}

/**
 * Jukebox behavior: if nothing is playing but tracks are queued, promote the
 * next one. Called after each submit (and at boot) so an idle room starts
 * playing as soon as the first song arrives; extensions just follow `current`.
 */
function promoteNextIfIdle() {
  if (state.current || state.queue.length === 0) return;
  state.current = state.queue.shift();
  state.current.status = "playing";
  state.revision += 1;
  saveState();
  broadcast();
}

/** Remove a queued item by id (admin). Returns the removed item or null. */
function deleteQueued(id) {
  const idx = state.queue.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  const [removed] = state.queue.splice(idx, 1);
  state.revision += 1;
  saveState();
  broadcast();
  return removed;
}

/** Move a queued item up or down by one position (admin). */
function reorderQueued(id, direction) {
  const idx = state.queue.findIndex((i) => i.id === id);
  if (idx < 0) return { ok: false, message: "not in queue" };
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0) return { ok: false, message: "already at the top of the queue" };
  if (target >= state.queue.length) return { ok: false, message: "already at the bottom of the queue" };
  [state.queue[idx], state.queue[target]] = [state.queue[target], state.queue[idx]];
  state.revision += 1;
  saveState();
  broadcast();
  return { ok: true };
}

/** Change an admin config flag. */
function setConfig(patch) {
  state.config = { ...state.config, ...patch };
  state.revision += 1;
  saveState();
  broadcast();
  return state.config;
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

/**
 * CORS + Chrome Private Network Access handling.
 *
 * The extension's content scripts run inside the (public) bilibili page and
 * talk to this (local network) server, so Chrome sends a preflight OPTIONS
 * request carrying `Access-Control-Private-Network-Request: true`. We must
 * acknowledge it explicitly or the browser blocks the request.
 */
function handlePreflight(req, res) {
  if (req.method !== "OPTIONS") return false;
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1e5) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function publicState() {
  return {
    revision: state.revision,
    current: state.current,
    queue: state.queue,
    history: state.history,
    config: state.config,
  };
}

/** Broadcast the full state snapshot to every SSE subscriber. */
function broadcast() {
  const frame = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const client of sseClients) client.write(frame);
}

// Keep-alive pings so proxies/browsers do not close idle SSE connections.
setInterval(() => {
  for (const client of sseClients) client.write(": ping\n\n");
}, 15000).unref();

function serveStatic(res, name) {
  const file = path.join(STATIC_DIR, name);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(file));
}

function serveEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

/** Gate admin requests: any query/header PIN must match ADMIN_PIN. */
function adminAuthorized(req, url) {
  if (!ADMIN_PIN) return true;
  const provided = url.searchParams.get("pin") || req.headers["x-admin-pin"];
  return provided === ADMIN_PIN;
}

async function route(req, res, isAdmin = false) {
  if (handlePreflight(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (isAdmin) return routeAdmin(req, res, url, pathname);

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return serveStatic(res, "index.html");
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return sendJson(res, 200, publicState());
  }

  if (req.method === "GET" && pathname === "/api/events") {
    return serveEvents(req, res);
  }

  if (req.method === "POST" && pathname === "/api/submit") {
    const body = await readJsonBody(req);
    try {
      const parsed = await parseInput(body.input);
      const view = await fetchView(parsed);
      const item = makeItem(view, parsed.page, body.by);
      const dup = findInQueue(item);
      if (dup) {
        const where = dup.id === state.current?.id ? "正在播放" : "已在队列中";
        return sendJson(res, 409, {
          ok: false,
          message: `点歌失败：「${item.part || item.title}」（P${item.page}）${where}`,
        });
      }
      enqueue(item);
      promoteNextIfIdle();
      return sendJson(res, 200, { ok: true, item, state: publicState() });
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: String(err.message || err) });
    }
  }

  if (req.method === "POST" && (pathname === "/api/advance" || pathname === "/api/skip")) {
    const mark = pathname === "/api/skip" ? "skipped" : "played";
    return sendJson(res, 200, advance(mark));
  }

  res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
  res.end("not found");
}

/* Admin routes: served on the separate admin port. Mutations and reads
   are gated by ADMIN_PIN when one is configured. */
async function routeAdmin(req, res, url, pathname) {
  if (!adminAuthorized(req, url)) {
    return sendJson(res, 403, { ok: false, message: "admin PIN required (?pin= or x-admin-pin header)" });
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/admin.html")) {
    return serveStatic(res, "admin.html");
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return sendJson(res, 200, publicState());
  }

  if (req.method === "GET" && pathname === "/api/events") {
    return serveEvents(req, res);
  }

  if (req.method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, { ok: true, config: state.config });
  }

  if (req.method === "POST" && pathname === "/api/config") {
    const body = await readJsonBody(req);
    const patch = {};
    if (typeof body.allowQueuedDuplicates === "boolean") {
      patch.allowQueuedDuplicates = body.allowQueuedDuplicates;
    }
    if (!Object.keys(patch).length) {
      return sendJson(res, 400, { ok: false, message: "no recognized config keys" });
    }
    const config = setConfig(patch);
    return sendJson(res, 200, { ok: true, config });
  }

  if (req.method === "POST" && pathname === "/api/skip") {
    return sendJson(res, 200, advance("skipped"));
  }

  if (req.method === "POST" && pathname === "/api/delete") {
    const body = await readJsonBody(req);
    const removed = deleteQueued(String(body.id ?? ""));
    if (!removed) {
      return sendJson(res, 404, { ok: false, message: `id ${body.id} is not in the queue` });
    }
    return sendJson(res, 200, { ok: true, removed });
  }

  if (req.method === "POST" && pathname === "/api/reorder") {
    const body = await readJsonBody(req);
    const direction = body.direction === "up" || body.direction === "down" ? body.direction : null;
    if (!direction) {
      return sendJson(res, 400, { ok: false, message: "direction must be \"up\" or \"down\"" });
    }
    const result = reorderQueued(String(body.id ?? ""), direction);
    return sendJson(res, result.ok ? 200 : 404, result);
  }

  res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
  res.end("not found");
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

loadState();
promoteNextIfIdle(); // resume jukebox after a restart with a non-empty queue

const requestHandler = (req, res) => {
  route(req, res).catch((err) => {
    console.error("[http]", err);
    sendJson(res, 500, { ok: false, message: "internal error" });
  });
};

const adminHandler = (req, res) => {
  route(req, res, true).catch((err) => {
    console.error("[admin.http]", err);
    sendJson(res, 500, { ok: false, message: "internal error" });
  });
};

http
  .createServer(requestHandler)
  .listen(PORT, HOST, () => {
    console.log(`[karaqueue] queue server on http://${HOST}:${PORT}`);
  });
http
  .createServer(adminHandler)
  .listen(ADMIN_PORT, HOST, () => {
    const pin = ADMIN_PIN ? "PIN protected" : "no PIN set (ADMIN_PIN env to protect)";
    console.log(`[karaqueue] admin console on http://${HOST}:${ADMIN_PORT} (${pin})`);
  });
