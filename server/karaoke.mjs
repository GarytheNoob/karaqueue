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

// Overrides let integration tests point the resolver at a local mock.
const VIEW_API = process.env.KARAQUEUE_VIEW_API || "https://api.bilibili.com/x/web-interface/view";
const SPI_API = process.env.KARAQUEUE_SPI_API || "https://api.bilibili.com/x/frontend/finger/spi";
const META_CACHE_FILE = path.join(ROOT, "meta-cache.json");
const META_CACHE_TTL_MS = 24 * 3600 * 1000;
const META_CACHE_LIMIT = 300;

/** An error from bilibili's API that we can attribute precisely. */
class BiliApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // HTTP status or bilibili's body code
  }
}

/* ------------------------------------------------------------------ */
/* Metadata cache + risk-control defenses                              */
/* ------------------------------------------------------------------ */

// buvid3/buvid4 cookies seed most of bilibili's anonymous API access;
// fetching them once up front lowers the chance of a 412.
let buvidCookie = null;
async function getBuvid() {
  if (buvidCookie) return buvidCookie;
  try {
    const res = await fetch(SPI_API, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    if (body?.code === 0 && body.data?.b_3) {
      buvidCookie = `buvid3=${body.data.b_3}; buvid4=${body.data.b_4 ?? ""}`;
    }
  } catch {
    /* best effort: request without the cookie if SPI is unavailable */
  }
  return buvidCookie;
}

function loadMetaCache() {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(META_CACHE_FILE, "utf8"));
    for (const [key, value] of raw) map.set(key, value);
  } catch {
    /* missing/corrupt cache: start empty */
  }
  return map;
}
const metaCache = loadMetaCache();

function saveMetaCache() {
  // Cap the cache by dropping the oldest entries before writing.
  while (metaCache.size > META_CACHE_LIMIT) {
    metaCache.delete(metaCache.keys().next().value);
  }
  const tmp = `${META_CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...metaCache], null, 0));
  fs.renameSync(tmp, META_CACHE_FILE);
}

/** Persist a trimmed-down view so later requests need no network call. */
function rememberView(parsed, view) {
  const key = parsed.bvid ?? `av${parsed.aid}`;
  metaCache.set(key, {
    t: Date.now(),
    view: {
      bvid: view.bvid,
      title: view.title,
      owner: { name: view.owner?.name ?? "" },
      duration: view.duration,
      pic: view.pic,
      pages: Array.isArray(view.pages)
        ? view.pages.map((p) => ({ page: p.page, part: p.part, duration: p.duration }))
        : [],
    },
  });
  saveMetaCache();
}

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
    try {
      const res = await fetch(input, {
        headers: { "User-Agent": BROWSER_UA },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      input = res.url;
    } catch {
      throw new Error("b23 短链展开失败（网络或风控），请直接贴完整链接或 BV 号");
    }
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

/** Query bilibili's public web API for video metadata, with explicit
 *  status/content-type checking so blocked or HTML answers fail loudly. */
async function fetchView({ bvid, aid }) {
  const cookie = await getBuvid();
  const qs = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const res = await fetch(`${VIEW_API}?${qs}`, {
    headers: {
      "User-Agent": BROWSER_UA,
      Referer: "https://www.bilibili.com/",
      Origin: "https://www.bilibili.com",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const hints = {
      412: "B 站风控拦截（HTTP 412），请求被判定为异常客户端；稍后再试或先缓存元数据",
      403: `B 站拒绝访问（HTTP 403）`,
      429: "B 站限流（HTTP 429），请求太频繁",
    };
    throw new BiliApiError(hints[res.status] ?? `B 站接口异常（HTTP ${res.status}）`, res.status);
  }

  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!contentType.includes("json") || text.trimStart().startsWith("<")) {
    throw new BiliApiError(`B 站返回了网页而不是 JSON（HTTP ${res.status}），疑似风控页面`, res.status);
  }

  const body = JSON.parse(text);
  if (body.code !== 0) {
    const reasons = {
      [-400]: "invalid video id (bilibili rejected the id)",
      [-404]: "video not found (deleted or private?)",
      [-412]: "blocked by bilibili risk control (code -412)",
    };
    throw new BiliApiError(reasons[body.code] ?? `bilibili api code ${body.code}`, body.code);
  }
  return body.data;
}

/** Codes meaning "this submission itself is wrong": reject, don't degrade. */
const USER_ERROR_CODES = new Set([-400, -404]);

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

/** Build a queue item without metadata: playable link + bare title. */
function makeFallbackItem(parsed, page, requestedBy) {
  const bvid = parsed.bvid ?? null;
  const vid = bvid ?? `av${parsed.aid}`;
  const p = Math.max(page ?? 1, 1);
  const hasP = (parsed.page ?? 1) > 1; // only link the P the user asked for

  return {
    id: `${vid}:p${p}`,
    platform: "bilibili",
    video_id: vid,
    page: p,
    page_count: 0,
    title: `${vid}（元数据未获取）`,
    part: "",
    uploader: "",
    duration_s: 0,
    thumbnail: "",
    web_url: `https://www.bilibili.com/video/${vid}${hasP ? `?p=${p}` : ""}`,
    requested_by: requestedBy || "anonymous",
    requested_at: new Date().toISOString(),
  };
}

/**
 * Resolve view metadata for a parsed input, preferring the cache to avoid
 * hammering bilibili (and their risk control). Returns { view, warning }:
 *  - fresh cache hit -> no network at all
 *  - network success -> view from bilibili, cache updated
 *  - infra failure (412/HTML/timeout) with stale cache -> stale view
 *  - infra failure without cache     -> null view (caller enqueues a
 *     fallback item so the room keeps playing)
 *  - user errors (video really missing) are rethrown for a 400 response
 */
async function resolveView(parsed) {
  const key = parsed.bvid ?? `av${parsed.aid}`;
  const cached = metaCache.get(key);

  if (cached && Date.now() - cached.t < META_CACHE_TTL_MS) {
    return { view: cached.view, warning: null };
  }

  try {
    const view = await fetchView(parsed);
    rememberView(parsed, view);
    return { view, warning: null };
  } catch (err) {
    // Truly invalid or missing video: reject the submission outright.
    if (err instanceof BiliApiError && USER_ERROR_CODES.has(err.code)) throw err;

    if (cached) {
      return { view: cached.view, warning: "B站接口暂时不可用（风控或网络），已使用此前缓存的元数据" };
    }
    return {
      view: null,
      warning: "B站接口暂时不可用（风控或网络），已按纯链接加入队列，标题信息暂时缺失",
    };
  }
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
      const { view, warning } = await resolveView(parsed);
      // Truly missing videos (bilibili code -404) reject; infra failures
      // degrade to a link-only item so the room keeps playing.
      const item = view ? makeItem(view, parsed.page, body.by) : makeFallbackItem(parsed, parsed.page, body.by);
      const dup = findInQueue(item);
      if (dup) {
        const where = dup.id === state.current?.id ? "正在播放" : "已在队列中";
        return sendJson(res, 409, {
          ok: false,
          message: `点歌失败：「${dup.part || dup.title}」（P${dup.page}）${where}`,
        });
      }
      enqueue(item);
      promoteNextIfIdle();
      return sendJson(res, 200, { ok: true, item, warning, state: publicState() });
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
