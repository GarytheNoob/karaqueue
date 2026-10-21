#!/usr/bin/env node
/**
 * KaraQueue - queue server (prototype, zero dependencies).
 *
 * Public endpoints (PORT, default 7777):
 *   GET  /                -> song request page (static/index.html)
 *   GET  /api/state       -> full state snapshot
 *   GET  /api/hostinfo    -> LAN addresses + best-effort Wi-Fi SSID
 *                            (drives the request page's sidebar QR)
 *   GET  /ui/ui.js        -> shared browser UI helpers (fixed name)
 *   GET  /ui/theme.css    -> shared theme for both pages (fixed name)
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
 *                             /i18n/i18n.js is the shared core script;
 *                             /ui/theme.css, /ui/ui.js are shared)
 *   GET  /api/state       -> full state snapshot
 *   GET  /api/events      -> SSE stream
 *   GET  /api/config      -> { config }
 *   POST /api/config      -> { allowQueuedDuplicates, oneSongPerGuest: boolean }
 *   POST /api/skip        -> skip the current track
 *   POST /api/delete      -> { id }; remove a queued track
 *   POST /api/reorder     -> { id, direction: "up"|"down" } or
 *                            { id, index: absolute 0-based slot }
 *
 * Persistence: server/queue.json (in-memory state, written atomically).
 * User-facing server strings (submit errors, warnings) are translated
 * per request from the page's `X-Karaqueue-Lang` header or `?lang=`
 * query, using the same lang packs as the pages; default zh-CN.
 * Bilibili metadata: view API first; on API-level risk control (412,
 * geo-based, e.g. from Hong Kong) the plain video page is parsed as
 * fallback (KARAQUEUE_VIDEO_PAGE overrides its base URL for tests).
 * Run: node server/karaoke.mjs   (env: PORT, HOST, ADMIN_PORT)
 */
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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

/* --- server-side i18n ------------------------------------------------
 * The pages already carry a language choice (static/i18n lang packs,
 * picked by the switcher). Server-generated strings - API response
 * messages, degrade warnings - join the same files and are translated
 * at request time from the client's hint: the `X-Karaqueue-Lang`
 * header (pages always send it) or a `?lang=` query, falling back to
 * zh-CN. Unknown keys fall back to the zh-CN pack, keeping callers
 * without the header (the extension) fully in Chinese. */

const LANG_PACKS = {};
{
  try {
    for (const name of fs.readdirSync(path.join(STATIC_DIR, "i18n"))) {
      const m = name.match(/^([a-zA-Z-]+)\.json$/);
      if (!m) continue;
      const dict = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, "i18n", name), "utf8"));
      if (typeof dict === "object" && dict !== null && !Array.isArray(dict)) LANG_PACKS[m[1]] = dict;
    }
  } catch (err) {
    console.warn("[karaqueue] language packs unavailable:", err.message);
  }
}

const DEFAULT_LANG = "zh-CN";

function tr(lang, key, params) {
  const table = LANG_PACKS[lang] ?? LANG_PACKS[DEFAULT_LANG] ?? {};
  const raw = table[key] ?? LANG_PACKS[DEFAULT_LANG]?.[key] ?? key;
  if (!params) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (m, name) =>
    name in params ? String(params[name]) : "",
  );
}

/** Resolve the request language: `?lang=` wins over the header over zh-CN. */
function getLang(req, url) {
  const candidate = url.searchParams.get("lang") || req.headers["x-karaqueue-lang"];
  if (typeof candidate === "string" && candidate in LANG_PACKS) return candidate;
  return DEFAULT_LANG;
}

/** Item title for user-facing messages, with the localized
 *  missing-metadata suffix when the title is only a bare video id. */
function displayName(lang, item) {
  const base = String(item.part || (item.title ?? ""));
  return item.title_missing ? base + tr(lang, "card.meta_missing") : base;
}
/** An error from a platform metadata API that we can attribute precisely.
 *  `key`/`params` are the i18n coordinates; `message` stays as a Chinese
 *  fallback for non-i18n callers. */
class MetaApiError extends Error {
  constructor(message, code, key = null, params = null) {
    super(message);
    this.code = code; // HTTP status or a platform's body code
    this.key = key;
    this.params = params;
  }
}

/** An error caused directly by the submitted input (parse failures). */
class UserInputError extends Error {
  constructor(message, key, params = null) {
    super(message);
    this.key = key;
    this.params = params;
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
      migrateLegacyTitles(state);
      console.log(`[state] restored from ${DATA_FILE}`);
    }
  } catch {
    /* first run or corrupted file: start fresh */
  }
}

/** Items persisted before this i18n stage baked the Chinese
 *  "(metadata not fetched)" suffix into stored titles. Split it off into
 *  the language-independent `title_missing` flag so every client can
 *  render its own localized suffix. */
function migrateLegacyTitles(s) {
  const suffix = "（元数据未获取）";
  for (const item of [s.current, ...s.queue, ...s.history]) {
    if (item && typeof item.title === "string" && item.title.endsWith(suffix)) {
      item.title = item.title.slice(0, -suffix.length);
      item.title_missing = true;
    }
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
      throw new UserInputError(
        "b23 短链展开失败（网络或风控），请直接贴完整链接或 BV 号",
        "srv.b23_expand_failed",
      );
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

  throw new UserInputError(
    "没认出视频链接（支持 B 站 BV/av 号、YouTube 视频链接）",
    "srv.parse_failed",
  );
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
      412: ["B 站风控拦截（HTTP 412），请求被判定为异常客户端；稍后再试或先缓存元数据", "srv.bili_412"],
      403: ["B 站拒绝访问（HTTP 403）", "srv.bili_403"],
      429: ["B 站限流（HTTP 429），请求太频繁", "srv.bili_429"],
    };
    const hit = hints[res.status] ?? [`B 站接口异常（HTTP ${res.status}）`, "srv.bili_http"];
    throw new MetaApiError(
      hit[0].includes("{status}") ? hit[0].replace("{status}", res.status) : hit[0],
      res.status,
      hit[1],
      { status: res.status },
    );
  }

  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!contentType.includes("json") || text.trimStart().startsWith("<")) {
    throw new MetaApiError(
      `B 站返回了网页而不是 JSON（HTTP ${res.status}），疑似风控页面`,
      res.status,
      "srv.bili_html",
      { status: res.status },
    );
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

/** Parse a JSON object assigned to a JS global out of an HTML page.
 *  Starts at the first `{` after the marker and brace-counts to its
 *  matching partner, so trailing statements never confuse the parser. */
function extractJsonAfter(haystack, marker) {
  const start = haystack.indexOf(marker);
  if (start < 0) return null;
  let i = haystack.indexOf("{", start + marker.length);
  if (i < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let j = i; j < haystack.length; j++) {
    const c = haystack[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(haystack.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Page-level fallback for when the view API is not reachable at all -
 * geo-based risk control answers 412 to every API call from an
 * overseas exit (verified stable from Hong Kong), but the plain video
 * page still serves and carries the whole metadata in
 * window.__INITIAL_STATE__.videoData. Pages for deleted or
 * region-locked videos have no videoData ("where did the video go?"
 * placeholder) and fail exactly like an API infra error, so the
 * caller's degrade ladder stays in charge.
 */
async function fetchViewViaPage(parsed) {
  const vid = parsed.bvid ?? `av${parsed.aid}`;
  const base = process.env.KARAQUEUE_VIDEO_PAGE || "https://www.bilibili.com/video/";
  const res = await fetch(`${base}${vid}/`, {
    headers: {
      "User-Agent": BROWSER_UA,
      Referer: "https://www.bilibili.com/",
      Accept: "text/html,application/xhtml+xml,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new MetaApiError(`video page HTTP ${res.status}`, res.status);
  }
  const initialState = extractJsonAfter(await res.text(), "window.__INITIAL_STATE__=");
  const v = initialState?.videoData;
  if (!v || typeof v.title !== "string" || !v.bvid) {
    throw new MetaApiError(
      "video page has no videoData (removed, region-locked, or page markup changed)",
      "page",
    );
  }
  // Normalize into exactly the shape fetchView's body.data has, so the
  // cache and makeItem see one format regardless of the source.
  return {
    bvid: v.bvid,
    title: v.title,
    pic: v.pic ?? "",
    duration: v.duration ?? 0,
    owner: { name: v.owner?.name ?? "" },
    pages: Array.isArray(v.pages)
      ? v.pages.map((p) => ({ page: p.page, part: p.part, duration: p.duration }))
      : [],
  };
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
    title: vid,
    title_missing: true,
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

    // The API answer was noise (412 risk control, timeouts...): the page
    // may still serve. Tried before the stale cache so a working page
    // beats old data.
    try {
      const view = await fetchViewViaPage(parsed);
      rememberView(parsed, view);
      return { view, warning: null };
    } catch {
      /* next rung of the ladder: the stale cache */
    }

    if (cached) {
      return { view: cached.view, warning: { key: "srv.warn_bili_cache" } };
    }
    return {
      view: null,
      warning: { key: "srv.warn_bili_nocache" },
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
      401: ["视频在 YouTube 上锁定元数据（私密或不允许嵌入）", "srv.yt_401"],
      403: ["YouTube 拒绝访问（HTTP 403）", "srv.yt_403"],
      404: ["视频在 YouTube 上不存在或已删除（404）", "srv.yt_404"],
    };
    const hit = hints[out.status] ?? [`YouTube 接口异常（HTTP ${out.status}）`, "srv.yt_http"];
    throw new MetaApiError(
      hit[0].includes("{status}") ? hit[0].replace("{status}", out.status) : hit[0],
      out.status,
      hit[1],
      { status: out.status },
    );
  }

  if (!out.contentType.includes("json") || out.text.trimStart().startsWith("<")) {
    throw new MetaApiError(
      `YouTube 返回了网页而不是 JSON（HTTP ${out.status}）`,
      out.status,
      "srv.yt_html",
      { status: out.status },
    );
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
      return { meta: cached.meta, warning: { key: "srv.warn_yt_cache" } };
    }
    return {
      meta: null,
      warning: { key: "srv.warn_yt_nocache" },
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
    title: meta?.title ?? videoId,
    title_missing: !(meta?.title),
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
  if (idx < 0) return { ok: false, code: "srv.reorder_not_in_queue" };
  if (direction === "top" && idx === 0) return { ok: true }; // already first, nothing to do
  const target = direction === "up" ? idx - 1 : direction === "top" ? 0 : idx + 1;
  if (target < 0) return { ok: false, code: "srv.reorder_at_top" };
  if (target >= state.queue.length) return { ok: false, code: "srv.reorder_at_bottom" };
  const [item] = state.queue.splice(idx, 1);
  state.queue.splice(target, 0, item);
  state.revision += 1;
  saveState();
  broadcast();
  return { ok: true };
}

/** Drop a queued item onto an absolute slot (drag & drop, admin). The
 *  index is clamped into the queue, so the client never has to guess. */
function reorderQueuedTo(id, index) {
  const idx = state.queue.findIndex((i) => i.id === id);
  if (idx < 0) return { ok: false, code: "srv.reorder_not_in_queue" };
  const target = Math.max(0, Math.min(state.queue.length - 1, Number(index)));
  if (target === idx) return { ok: true }; // dropped in place
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
    const where = dup.id === state.current?.id ? "current" : "queued";
    return { ok: false, rerequest_dup: { title: item.part || item.title, title_missing: item.title_missing, page: item.page, where } };
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

/* ------------------------------------------------------------------ */
/* LAN host info (request-page sidebar: SSID, addresses, QR target)    */
/* ------------------------------------------------------------------ */

let hostInfoCache = null;

/** All routable IPv4 addresses of this machine's LAN interfaces. */
function lanIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list ?? []) {
      if (it.family !== "IPv4" || it.internal) continue;
      if (/^169\.254\./.test(it.address)) continue; // link-local, useless for guests
      out.push(it.address);
    }
  }
  return out;
}

/** Best-effort Wi-Fi SSID. Host systems guard it behind privacy
 *  permissions: macOS 15+ answers "<redacted>" unless the process has
 *  Location permission. Nulls are reported as "not detected" upstream. */
function hostSsid() {
  try {
    if (process.platform === "darwin") {
      const ports = execFileSync("networksetup", ["-listallhardwareports"], {
        encoding: "utf8", timeout: 3000,
      });
      const wifi = ports.match(/Hardware Port: Wi-Fi\nDevice: (\w+)/);
      if (wifi) {
        const summary = execFileSync("ipconfig", ["getsummary", wifi[1]], {
          encoding: "utf8", timeout: 3000,
        });
        const ssid = (summary.match(/ SSID : (.+)/)?.[1] ?? "").trim();
        if (ssid && ssid !== "<redacted>") return ssid;
      }
    } else if (process.platform === "linux") {
      const ssid = execFileSync("iwgetid", ["-r"], { encoding: "utf8", timeout: 3000 }).trim();
      if (ssid) return ssid;
    }
  } catch {
    /* missing tooling or no association: fall through to "not detected" */
  }
  return null;
}

/** The address to advertise: the IPv4 the very request arrived on, so
 *  guests connected over VPN/tunnel interfaces still get a QR that
 *  reaches them; falls back to the first enumerated LAN IPv4. */
function primaryLanIp(req) {
  const a = String(req.socket.localAddress || "").replace(/^::ffff:/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a) && !/^(127\.|0\.)/.test(a)) return a;
  return lanHostInfo().ips[0] ?? null;
}

/** Cached for a minute: guests flood this while the QR sits open, and
 *  the underlying probes spawn subprocesses under a privacy redaction
 *  that will not flip mid-party anyway. */
function lanHostInfo() {
  const now = Date.now();
  if (hostInfoCache && now - hostInfoCache.t < 60_000) return hostInfoCache.v;
  const v = { hostname: os.hostname(), port: PORT, ips: lanIPv4s(), ssid: hostSsid() };
  hostInfoCache = { t: now, v };
  return v;
}

async function route(req, res, isAdmin = false) {
  if (handlePreflight(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const lang = getLang(req, url);

  if (isAdmin) return routeAdmin(req, res, url, pathname);

  const langMatch = req.method === "GET" && pathname.match(I18N_PATH_RE);
  if (langMatch) return serveI18n(res, langMatch[1], langMatch[2]);

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return serveStatic(res, "index.html");
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return sendJson(res, 200, publicState());
  }

  if (req.method === "GET" && pathname === "/api/hostinfo") {
    return sendJson(res, 200, { ok: true, host: { ...lanHostInfo(), primary: primaryLanIp(req) } });
  }

  // Vendored browser libs and the shared UI script (no npm). Fixed
  // file names only - the route never interpolates the pathname, so
  // there is no traversal surface.
  if (req.method === "GET" && (pathname === "/vendor/qrcode.js" || pathname === "/ui/ui.js" || pathname === "/ui/theme.css")) {
    const [rel, type] = pathname === "/vendor/qrcode.js"
      ? ["vendor/qrcode.js", "text/javascript; charset=utf-8"]
      : pathname === "/ui/theme.css"
        ? [path.join("ui", "theme.css"), "text/css; charset=utf-8"]
        : [path.join("ui", "ui.js"), "text/javascript; charset=utf-8"];
    try {
      res.writeHead(200, { "Content-Type": type });
      res.end(fs.readFileSync(path.join(STATIC_DIR, rel)));
    } catch {
      sendJson(res, 404, { ok: false, message: `no such static file: ${pathname}` });
    }
    return;
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
          code: pending.id === state.current?.id ? "srv.fair_locked_playing" : "srv.fair_locked_queued",
          message: tr(lang, pending.id === state.current?.id ? "srv.fair_locked_playing" : "srv.fair_locked_queued", {
            title: displayName(lang, pending),
          }),
        });
      }
    }
    try {
      const parsed = await parseInput(body.input);
      // Truly missing videos (bilibili code -404) reject; infra failures
      // degrade to a link-only item so the room keeps playing.
      const { item, warning: warnKey } = await resolveItem(parsed, body.by);
      const warning = warnKey ? tr(lang, warnKey.key, warnKey.params) : null;
      // Bind the browser cookie uid so fair-mode lockout keeps working
      // even if the guest changes their nickname later.
      item.requester_uid = String(body.uid ?? "").slice(0, 80) || null;
      const dup = findInQueue(item);
      if (dup) {
        const dupKey = dup.id === state.current?.id ? "srv.dup_playing" : "srv.dup_queued";
        return sendJson(res, 409, {
          ok: false,
          code: dupKey,
          message: tr(lang, dupKey, { title: displayName(lang, dup), page: dup.page }),
        });
      }
      enqueue(item);
      promoteNextIfIdle();
      return sendJson(res, 200, { ok: true, item, warning, state: publicState() });
    } catch (err) {
      return sendJson(res, 400, {
        ok: false,
        code: err.key ?? null,
        message: err.key ? tr(lang, err.key, err.params) : String(err.message || err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/api/withdraw") {
    const body = await readJsonBody(req);
    const result = withdrawQueued(String(body.id ?? ""), String(body.uid ?? ""));
    if (result.forbidden) {
      return sendJson(res, 403, {
        ok: false,
        code: "srv.withdraw_forbidden",
        message: tr(lang, "srv.withdraw_forbidden"),
      });
    }
    if (result.missing) {
      const key = result.playing ? "srv.withdraw_playing" : "srv.withdraw_missing";
      return sendJson(res, 404, { ok: false, code: key, message: tr(lang, key) });
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
  const lang = getLang(req, url);
  if (req.method === "GET" && (pathname === "/" || pathname === "/admin.html")) {
    return serveStatic(res, "admin.html");
  }

  const langMatch = req.method === "GET" && pathname.match(I18N_PATH_RE);
  if (langMatch) return serveI18n(res, langMatch[1], langMatch[2]);

  // Same hostinfo the request page uses: the admin drawer's QR points
  // guests at the request page on the public port.
  if (req.method === "GET" && pathname === "/api/hostinfo") {
    return sendJson(res, 200, { ok: true, host: { ...lanHostInfo(), primary: primaryLanIp(req) } });
  }

  // Shared theme, UI script and the QR vendor lib, same fixed-name
  // contract as the public port's /ui/ and /vendor/ routes.
  if (req.method === "GET" && (pathname === "/ui/ui.js" || pathname === "/vendor/qrcode.js" || pathname === "/ui/theme.css")) {
    const [rel, type] = pathname === "/vendor/qrcode.js"
      ? ["vendor/qrcode.js", "text/javascript; charset=utf-8"]
      : pathname === "/ui/theme.css"
        ? [path.join("ui", "theme.css"), "text/css; charset=utf-8"]
        : [path.join("ui", "ui.js"), "text/javascript; charset=utf-8"];
    try {
      res.writeHead(200, { "Content-Type": type });
      res.end(fs.readFileSync(path.join(STATIC_DIR, rel)));
    } catch {
      sendJson(res, 404, { ok: false, message: `no such static file: ${pathname}` });
    }
    return;
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
      return sendJson(res, 404, {
        ok: false,
        code: "srv.id_not_in_queue",
        message: tr(lang, "srv.id_not_in_queue", { id: body.id }),
      });
    }
    return sendJson(res, 200, { ok: true, removed });
  }

  if (req.method === "POST" && pathname === "/api/reorder") {
    const body = await readJsonBody(req);
    let result;
    if (body.index !== undefined) {
      if (!Number.isInteger(body.index)) {
        return sendJson(res, 400, { ok: false, message: "index must be an integer when given" });
      }
      result = reorderQueuedTo(String(body.id ?? ""), body.index);
    } else {
      const direction = ["up", "down", "top"].includes(body.direction) ? body.direction : null;
      if (!direction) {
        return sendJson(res, 400, { ok: false, message: 'direction must be "up", "down" or "top" (or pass an integer index)' });
      }
      result = reorderQueued(String(body.id ?? ""), direction);
    }
    if (!result.ok) {
      return sendJson(res, 404, {
        ...result,
        message: tr(lang, result.code),
      });
    }
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/rerequest") {
    const body = await readJsonBody(req);
    const result = reRequest(String(body.id ?? ""), body.by);
    if (result.notFound) {
      return sendJson(res, 404, {
        ok: false,
        code: "srv.id_not_in_history",
        message: tr(lang, "srv.id_not_in_history", { id: body.id }),
      });
    }
    if (result.rerequest_dup) {
      const d = result.rerequest_dup;
      const key = d.where === "current" ? "srv.dup_playing" : "srv.dup_queued";
      return sendJson(res, 409, {
        ok: false,
        code: key,
        message: tr(lang, key, { title: d.title + (d.title_missing ? tr(lang, "card.meta_missing") : ""), page: d.page }),
      });
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