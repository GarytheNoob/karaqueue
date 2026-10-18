#!/usr/bin/env node
/**
 * KaraQueue - queue server (prototype, zero dependencies).
 *
 * Public endpoints (PORT, default 7777):
 *   GET  /                -> song request page (static/index.html)
 *   GET  /api/state       -> full state snapshot
 *   POST /api/submit      -> body { input, by, uid }; resolves input, enqueues it
 *                              (uid binds the request to the browser cookie
 *                              so fair-mode lockout survives nickname edits)
 *
 *   POST /api/advance     -> mark current as played, promote the next item
 *   POST /api/skip        -> mark current as skipped, promote the next item
 *   POST /api/withdraw    -> { id, uid }; remove a queued track, but only
 *                            if its requested_by uid matches (guests can
 *                            only withdraw their own requests)
 *   GET  /api/events      -> SSE stream; broadcasts full state on every change
 *
 * Admin endpoints (ADMIN_PORT, default 7778):
 *   GET  /                -> admin console (static/admin.html)
 *   GET  /i18n/<lang>.json -> UI strings for the page language switcher
 *                             (files under static/i18n/; public port too,
 *                             /i18n/i18n.js is the shared core script)
 *   GET  /api/state       -> full state snapshot
 *   GET  /api/events      -> SSE stream
 *   GET  /api/config      -> { config }
 *   POST /api/config      -> { allowQueuedDuplicates, oneSongPerGuest: boolean }
 *   POST /api/skip        -> skip the current track
 *   POST /api/delete      -> { id }; remove a queued track
 *   POST /api/reorder     -> { id, direction: "up"|"down" }
 *
 * Persistence: server/queue.json (in-memory state, written atomically).
 * Run: node server/karaoke.mjs   (env: PORT, HOST, ADMIN_PORT)
 */
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 7778);
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
  config: { allowQueuedDuplicates: false, oneSongPerGuest: false },
  revision: 0,
};
const DEFAULT_CONFIG = { allowQueuedDuplicates: false, oneSongPerGuest: false };
const sseClients = new Set();

// Overrides let integration tests point the resolver at a local mock.
const VIEW_API = process.env.KARAQUEUE_VIEW_API || "https://api.bilibili.com/x/web-interface/view";
const SPI_API = process.env.KARAQUEUE_SPI_API || "https://api.bilibili.com/x/frontend/finger/spi";
// Keyless, official: title/author/thumb only, no duration.
const OEMBED_API = process.env.KARAQUEUE_OEMBED_API || "https://www.youtube.com/oembed";
const META_CACHE_FILE = path.join(ROOT, "meta-cache.json");
const META_CACHE_TTL_MS = 24 * 3600 * 1000;
const META_CACHE_LIMIT = 300;

/** An error from a platform metadata API that we can attribute precisely. */
class MetaApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // HTTP status or a platform's body code
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

/** Persist the trimmed YouTube oEmbed payload under a `yt:` prefixed key. */
function rememberYouTubeMeta(videoId, meta) {
  metaCache.set(`yt:${videoId}`, {
    t: Date.now(),
    meta: {
      title: meta.title ?? "",
      author_name: meta.author_name ?? "",
      thumbnail_url: meta.thumbnail_url ?? "",
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
/* Outbound proxy (for platforms the LAN cannot reach directly)         */
/* ------------------------------------------------------------------ */

// Node's global fetch ignores OS proxy settings, so a network that needs
// a proxy to reach YouTube gets plain connection failures. We pick up the
// proxy once at startup (KARAQUEUE_PROXY / HTTPS_PROXY env, or the macOS
// system proxy) and tunnel the requests that need it through an
// HTTP CONNECT + TLS pair built on node:net / node:tls - no dependencies.
// Local and LAN targets (test mock seams, the LAN server) always bypass
// the tunnel, and bilibili requests stay direct on purpose.

let activeProxy = null; // { host, port, source } | null

function loadProxyConfig() {
  const fromEnv =
    process.env.KARAQUEUE_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (fromEnv) {
    activeProxy = parseProxy(fromEnv, "env HTTPS_PROXY/KARAQUEUE_PROXY");
  }
  if (!activeProxy && process.platform === "darwin") {
    activeProxy = macOSSystemProxy();
  }
  if (activeProxy) {
    console.log(
      `[karaqueue] cross-network requests go through proxy ${activeProxy.host}:${activeProxy.port}` +
        ` (${activeProxy.source}); bilibili stays direct`,
    );
  } else {
    console.log("[karaqueue] no outbound proxy found; cross-network requests go direct");
  }
}

function parseProxy(str, source) {
  const s = String(str || "").trim();
  const url = s.match(/^(?:https?|socks[45]h?):\/\/([^/:@\s]+):(\d+)/i);
  if (url) return { host: url[1], port: Number(url[2]), source };
  const hostPort = s.match(/^([^/:@\s]+):(\d+)$/);
  if (hostPort) return { host: hostPort[1], port: Number(hostPort[2]), source };
  return null;
}

/** macOS "system proxy" lives in scutil, not in env vars. */
function macOSSystemProxy() {
  try {
    const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000 });
    const pick = (key) => out.match(new RegExp(`${key}\\s*:\\s*(\\S+)`))?.[1];
    // An HTTPS proxy entry answers plain HTTP CONNECT, so prefer it.
    for (const [enableKey, hostKey, portKey] of [
      ["HTTPSEnable", "HTTPSProxy", "HTTPSPort"],
      ["HTTPEnable", "HTTPProxy", "HTTPPort"],
    ]) {
      if (Number(pick(enableKey)) === 1 && pick(hostKey)) {
        return { host: pick(hostKey), port: Number(pick(portKey)) || 8080, source: "macOS system proxy" };
      }
    }
    if (Number(pick("SOCKSEnable")) === 1) {
      console.log("[karaqueue] system proxy is SOCKS-only (not supported); cross-network requests stay direct");
    }
  } catch {
    /* headless or no scutil: stay direct */
  }
  return null;
}

/** Only public hosts use the proxy; localhost / LAN (mock seams too)
 * always go direct so the integration test seam keeps working. */
function shouldProxy(url) {
  if (!activeProxy) return false;
  const host = new URL(url).hostname;
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  return true;
}

/** One HTTPS GET through the current HTTP proxy: CONNECT the tunnel, wrap
 * the socket in TLS, send a plain GET with Connection: close, read one
 * full response and parse it. */
function httpsGetViaProxy(urlString, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const target = `${u.hostname}:${u.port || 443}`;
    const sock = net.connect({ host: activeProxy.host, port: activeProxy.port }, () => {
      // Ask the proxy to punch the tunnel first.
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let tlsSocket = null;
    let timer = null;
    const fail = (message) => {
      clearTimeout(timer);
      sock.destroy();
      tlsSocket?.destroy();
      reject(new MetaApiError(`tunnel request failed: ${message}`, "proxy"));
    };
    timer = setTimeout(() => fail("timeout"), timeoutMs);
    sock.on("error", (e) => fail(e.message));

    // Stage 1: the proxy's answer to our CONNECT.
    let head = "";
    sock.on("data", function onData(chunk) {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      sock.off("data", onData);
      const status = head.slice(0, head.indexOf("\r\n"));
      if (!/^HTTP\/1\.[01] 200/.test(status)) return fail(`CONNECT refused: ${status}`);

      // Stage 2: TLS inside the tunnel, then a plain GET.
      tlsSocket = tls.connect({ socket: sock, servername: u.hostname }, () => {
        const lines = Object.entries({ Host: u.hostname, Connection: "close", ...headers })
          .map(([k, v]) => `${k}: ${v}`);
        tlsSocket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      });
      tlsSocket.on("error", (e) => fail(`TLS/GET failed: ${e.message}`));
      const chunks = [];
      tlsSocket.on("data", (c) => chunks.push(c));
      tlsSocket.on("close", () => {
        clearTimeout(timer);
        try {
          resolve(parseHttpMessage(Buffer.concat(chunks)));
        } catch (e) {
          reject(e instanceof MetaApiError ? e : new MetaApiError(`proxy response parse failed: ${e.message}`, "proxy"));
        }
      });
    });
  });
}

/** Split an HTTP/1.1 response into status/content-type/body, de-chunking
 * when needed. Body bytes stay raw UTF-8 (titles carry CJK/emoji). */
function parseHttpMessage(buf) {
  const raw = buf.toString("latin1");
  const sep = raw.indexOf("\r\n\r\n");
  if (sep < 0) throw new MetaApiError("proxy response incomplete", "proxy");
  const headLines = raw.slice(0, sep).split("\r\n");
  const headers = {};
  for (const line of headLines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body = buf.subarray(sep + 4);
  if ((headers["transfer-encoding"] || "").includes("chunked")) body = deChunk(body);
  return {
    status: Number(headLines[0].split(" ")[1]) || 0,
    contentType: headers["content-type"] ?? "",
    text: body.toString("utf8"),
  };
}

/** Collapse chunked transfer coding back to raw body bytes. */
function deChunk(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const lineEnd = body.indexOf("\r\n", i);
    if (lineEnd < 0) break;
    const size = parseInt(body.subarray(i, lineEnd).toString("latin1").split(";")[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(body.subarray(lineEnd + 2, Math.min(lineEnd + 2 + size, body.length)));
    i = lineEnd + 2 + size + 2; // past the chunk data and its closing CRLF
  }
  return Buffer.concat(out);
}

/** GET one URL. Public hosts tunnel through the proxy when there is one;
 * localhost and LAN targets always use plain fetch. */
async function httpGet(url, headers, timeoutMs) {
  if (shouldProxy(url)) return httpsGetViaProxy(url, headers, timeoutMs);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
}

/* ------------------------------------------------------------------ */
/* Track resolution                                                    */
/* ------------------------------------------------------------------ */

const BV_RE = /(BV[0-9A-Za-z]{10})/;
const AID_RE = /av(\d{4,})/i;
const PAGE_RE = /[?&]p=(\d+)/;
// watch?v=, youtu.be, /shorts/, /embed/, /live/ all land on one video id.
// The lookahead keeps following id characters out of the 11-char group.
const YT_RAW_RE = /(?:youtube\.com\/watch\?[^ ]*?v=|youtube\.com\/(?:shorts|embed|live)\/|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i;

/**
 * Parse a user submission (BV id, av id, full URL, b23.tv short link)
 * into { platform, bvid?, aid?, page }. The platform tag lets later
 * steps dispatch to a per-source resolver.
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

  // Do not canonicalize pasted URLs before per-platform dispatch; other
  // platforms get their own branch here and keep their original URL.

  // --- youtube ----------------------------------------------------------
  const yt = input.match(YT_RAW_RE);
  if (yt) return { platform: "youtube", videoId: yt[1] };

  // --- bilibili ---------------------------------------------------------
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
  if (bv) return { platform: "bilibili", bvid: bv[1], page };
  const aid = input.match(AID_RE);
  if (aid) return { platform: "bilibili", aid: aid[1], page };

  throw new Error("没认出视频链接（支持 B 站 BV/av 号、YouTube 视频链接）");
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
    throw new MetaApiError(hints[res.status] ?? `B 站接口异常（HTTP ${res.status}）`, res.status);
  }

  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!contentType.includes("json") || text.trimStart().startsWith("<")) {
    throw new MetaApiError(`B 站返回了网页而不是 JSON（HTTP ${res.status}），疑似风控页面`, res.status);
  }

  const body = JSON.parse(text);
  if (body.code !== 0) {
    const reasons = {
      [-400]: "invalid video id (bilibili rejected the id)",
      [-404]: "video not found (deleted or private?)",
      [-412]: "blocked by bilibili risk control (code -412)",
    };
    throw new MetaApiError(reasons[body.code] ?? `bilibili api code ${body.code}`, body.code);
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
    if (err instanceof MetaApiError && USER_ERROR_CODES.has(err.code)) throw err;

    if (cached) {
      return { view: cached.view, warning: "B站接口暂时不可用（风控或网络），已使用此前缓存的元数据" };
    }
    return {
      view: null,
      warning: "B站接口暂时不可用（风控或网络），已按纯链接加入队列，标题信息暂时缺失",
    };
  }
}

/* --- youtube ---------------------------------------------------------- */

/**
 * Query YouTube's keyless oEmbed endpoint. It answers with the title,
 * author and thumbnail but never a duration, and it answers 401/403 for
 * private or embed-disabled videos (those still play on youtube.com, so
 * unlike a 404 they degrade to a link-only item instead of rejecting).
 */
async function fetchYouTubeMeta(videoId) {
  const target = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  const out = await httpGet(
    `${OEMBED_API}?format=json&url=${target}`,
    { "User-Agent": BROWSER_UA, Accept: "application/json" },
    12000,
  );

  if (out.status !== 200) {
    const hints = {
      401: "视频在 YouTube 上锁定元数据（私密或不允许嵌入）",
      403: "YouTube 拒绝访问（HTTP 403）",
      404: "视频在 YouTube 上不存在或已删除（404）",
    };
    throw new MetaApiError(hints[out.status] ?? `YouTube 接口异常（HTTP ${out.status}）`, out.status);
  }

  if (!out.contentType.includes("json") || out.text.trimStart().startsWith("<")) {
    throw new MetaApiError(`YouTube 返回了网页而不是 JSON（HTTP ${out.status}）`, out.status);
  }
  return JSON.parse(out.text);
}

/**
 * Resolve YouTube metadata with the same cache/degrade ladder as
 * bilibili: fresh cache -> no network; stale cache -> degraded warning;
 * nothing -> link-only fallback. Only a definitive 404 rejects.
 */
async function resolveYouTubeMeta(videoId) {
  const key = `yt:${videoId}`;
  const cached = metaCache.get(key);

  if (cached?.meta && Date.now() - cached.t < META_CACHE_TTL_MS) {
    return { meta: cached.meta, warning: null };
  }

  try {
    const meta = await fetchYouTubeMeta(videoId);
    rememberYouTubeMeta(videoId, meta);
    return { meta, warning: null };
  } catch (err) {
    console.warn(`[karaqueue] youtube metadata fetch failed (${videoId}):`, err.message);
    // The video itself is gone: reject the submission outright.
    if (err instanceof MetaApiError && err.code === 404) throw err;

    if (cached?.meta) {
      return { meta: cached.meta, warning: "YouTube 元数据暂时拿不到（网络或权限），已使用此前缓存的元数据" };
    }
    return {
      meta: null,
      warning: "YouTube 元数据暂时拿不到（网络或权限），已按纯链接加入队列，标题信息暂时缺失",
    };
  }
}

/** Build the YouTube queue item; runtime details come from the player,
 * since oEmbed has no duration and YouTube has no numbered pages. */
function makeYouTubeItem(videoId, meta, requestedBy) {
  return {
    id: `${videoId}:p1`,
    platform: "youtube",
    video_id: videoId,
    page: 1,
    page_count: 0,
    title: meta?.title ?? `${videoId}（元数据未获取）`,
    part: "",
    uploader: meta?.author_name ?? "",
    duration_s: 0,
    thumbnail: meta?.thumbnail_url ?? "",
    web_url: `https://www.youtube.com/watch?v=${videoId}`,
    requested_by: requestedBy || "anonymous",
    requested_at: new Date().toISOString(),
  };
}

/**
 * Resolve parsed input to a finished queue item. Per-platform dispatch
 * lives here so the route handler stays source-agnostic.
 * Returns { item, warning } (warning present on degraded resolution).
 */
async function resolveItem(parsed, requestedBy) {
  if (parsed.platform === "youtube") {
    const { meta, warning } = await resolveYouTubeMeta(parsed.videoId);
    return { item: makeYouTubeItem(parsed.videoId, meta, requestedBy), warning };
  }
  if (parsed.platform !== "bilibili") {
    throw new Error(`unsupported platform: ${parsed.platform}`);
  }
  const { view, warning } = await resolveView(parsed);
  const item = view ? makeItem(view, parsed.page, requestedBy) : makeFallbackItem(parsed, parsed.page, requestedBy);
  return { item, warning };
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
 * Guest-side withdrawal: remove a queued track, but only the requesting
 * browser may withdraw its own submission (uid match). Works regardless
 * of the fair-mode toggle. Playing tracks are out of scope: promote/skip
 * stays with the host.
 */
function withdrawQueued(id, uid) {
  const idx = state.queue.findIndex((i) => i.id === id);
  if (idx < 0) {
    return { missing: true, playing: state.current?.id === id };
  }
  const item = state.queue[idx];
  if (!uid || item.requester_uid !== uid) return { forbidden: true };
  state.queue.splice(idx, 1);
  state.revision += 1;
  saveState();
  broadcast();
  return { ok: true, item };
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

/** Move a queued item up, down, or all the way to the top (admin). */
function reorderQueued(id, direction) {
  const idx = state.queue.findIndex((i) => i.id === id);
  if (idx < 0) return { ok: false, message: "not in queue" };
  if (direction === "top" && idx === 0) return { ok: true }; // already first, nothing to do
  const target = direction === "up" ? idx - 1 : direction === "top" ? 0 : idx + 1;
  if (target < 0) return { ok: false, message: "already at the top of the queue" };
  if (target >= state.queue.length) return { ok: false, message: "already at the bottom of the queue" };
  const [item] = state.queue.splice(idx, 1);
  state.queue.splice(target, 0, item);
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

/**
 * Fair-mode check: find what a guest already has pending, matched by their
 * browser cookie uid (nickname alone is not reliable). Covers both the
 * currently playing track and the queue, so a guest can request a new song
 * as soon as their own one has finished playing.
 */
function findPendingForGuest(uid) {
  if (!uid) return null;
  const active = state.current ? [state.current, ...state.queue] : state.queue;
  return active.find((i) => i.requester_uid && i.requester_uid === uid) ?? null;
}

/**
 * Re-request a track from the play history (admin "play it again"):
 * copies the stored item into the queue with a fresh timestamp and
 * requester, running the same duplicate rules as a fresh submission.
 */
function reRequest(id, by) {
  const src = state.history.find((h) => h.id === id);
  if (!src) return { ok: false, notFound: true };
  const item = {
    ...src,
    requested_by: by || "admin",
    requested_at: new Date().toISOString(),
  };
  delete item.status;
  delete item.finished_at;
  // A host re-request is the admin's own action: it must not count against
  // the original guest's fair-mode quota.
  item.requester_uid = null;
  const dup = findInQueue(item);
  if (dup) {
    const where = dup.id === state.current?.id ? "正在播放" : "已在队列中";
    return { ok: false, dupMessage: `点歌失败：「${item.part || item.title}」（P${item.page}）${where}` };
  }
  state.queue.push(item);
  state.revision += 1;
  saveState();
  broadcast();
  // Same jukebox semantics as /api/submit: an idle room starts playing
  // the re-requested track immediately.
  promoteNextIfIdle();
  return { ok: true, item };
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

// One translation file per language plus the shared i18n core, all under
// static/i18n/: /i18n/<lang>.json from the pages, /i18n/i18n.js loaded by
// the page <script>. Pages fetch them relative to their origin so both
// ports need the route. The name is regex-validated before touching the
// filesystem, so there is no path traversal surface.
const I18N_PATH_RE = /^\/i18n\/([a-zA-Z0-9-]{2,10})\.(json|js)$/;
function serveI18n(res, name, ext) {
  const mime = ext === "js" ? "text/javascript; charset=utf-8" : "application/json; charset=utf-8";
  try {
    const file = fs.readFileSync(path.join(STATIC_DIR, "i18n", `${name}.${ext}`));
    res.writeHead(200, { "Content-Type": mime });
    res.end(file);
  } catch {
    sendJson(res, 404, { ok: false, message: `no such file under /i18n/: ${name}.${ext}` });
  }
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

async function route(req, res, isAdmin = false) {
  if (handlePreflight(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (isAdmin) return routeAdmin(req, res, url, pathname);

  const langMatch = req.method === "GET" && pathname.match(I18N_PATH_RE);
  if (langMatch) return serveI18n(res, langMatch[1], langMatch[2]);

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
    // Fair mode: one song per guest at a time. Checked before parsing so
    // locked guests never trigger bilibili metadata requests.
    if (state.config.oneSongPerGuest) {
      const pending = findPendingForGuest(String(body.uid ?? ""));
      if (pending) {
        return sendJson(res, 403, {
          ok: false,
          message: `限点一首：你点的「${pending.part || pending.title}」${pending.id === state.current?.id ? "正在播放" : "还在队列里"}，等它唱完才能再点`,
        });
      }
    }
    try {
      const parsed = await parseInput(body.input);
      // Truly missing videos (bilibili code -404) reject; infra failures
      // degrade to a link-only item so the room keeps playing.
      const { item, warning } = await resolveItem(parsed, body.by);
      // Bind the browser cookie uid so fair-mode lockout keeps working
      // even if the guest changes their nickname later.
      item.requester_uid = String(body.uid ?? "").slice(0, 80) || null;
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

  if (req.method === "POST" && pathname === "/api/withdraw") {
    const body = await readJsonBody(req);
    const result = withdrawQueued(String(body.id ?? ""), String(body.uid ?? ""));
    if (result.forbidden) {
      return sendJson(res, 403, { ok: false, message: "只能撤回自己点的歌" });
    }
    if (result.missing) {
      return sendJson(res, 404, {
        ok: false,
        message: result.playing
          ? "这首正在播放中，撤回不了——切歌请找房主"
          : "这首歌已不在队列中（可能唱完了或刚被移出）",
      });
    }
    return sendJson(res, 200, { ok: true, item: result.item, state: publicState() });
  }

  if (req.method === "POST" && (pathname === "/api/advance" || pathname === "/api/skip")) {
    const mark = pathname === "/api/skip" ? "skipped" : "played";
    return sendJson(res, 200, advance(mark));
  }

  res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
  res.end("not found");
}

/* Admin routes: served on the separate admin port (LAN-trusted, no auth). */
async function routeAdmin(req, res, url, pathname) {
  if (req.method === "GET" && (pathname === "/" || pathname === "/admin.html")) {
    return serveStatic(res, "admin.html");
  }

  const langMatch = req.method === "GET" && pathname.match(I18N_PATH_RE);
  if (langMatch) return serveI18n(res, langMatch[1], langMatch[2]);

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
    if (typeof body.oneSongPerGuest === "boolean") {
      patch.oneSongPerGuest = body.oneSongPerGuest;
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
    const direction = ["up", "down", "top"].includes(body.direction) ? body.direction : null;
    if (!direction) {
      return sendJson(res, 400, { ok: false, message: 'direction must be "up", "down" or "top"' });
    }
    const result = reorderQueued(String(body.id ?? ""), direction);
    return sendJson(res, result.ok ? 200 : 404, result);
  }

  if (req.method === "POST" && pathname === "/api/rerequest") {
    const body = await readJsonBody(req);
    const result = reRequest(String(body.id ?? ""), body.by);
    if (result.notFound) {
      return sendJson(res, 404, { ok: false, message: `id ${body.id} is not in the play history` });
    }
    if (result.dupMessage) {
      return sendJson(res, 409, { ok: false, message: result.dupMessage });
    }
    return sendJson(res, 200, { ok: true, item: result.item });
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

// Discover the outbound proxy (env or macOS system proxy) before the
// first metadata request can need it.
loadProxyConfig();

http
  .createServer(requestHandler)
  .listen(PORT, HOST, () => {
    console.log(`[karaqueue] queue server on http://${HOST}:${PORT}`);
  });
http
  .createServer(adminHandler)
  .listen(ADMIN_PORT, HOST, () => {
    console.log(`[karaqueue] admin console on http://${HOST}:${ADMIN_PORT}`);
  });