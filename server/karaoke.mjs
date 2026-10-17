#!/usr/bin/env node
/**
 * Nikokara Player - queue server (prototype, zero dependencies).
 *
 * Endpoints:
 *   GET  /                -> song request page (static/index.html)
 *   GET  /api/state       -> { current, queue, history } snapshot
 *   POST /api/submit      -> body { input, by }; resolves input, enqueues it
 *   POST /api/advance     -> mark current as played, promote the next item
 *   POST /api/skip        -> mark current as skipped, promote the next item
 *   GET  /api/events      -> SSE stream; broadcasts full state on every change
 *
 * Persistence: server/queue.json (in-memory state, written atomically).
 * Run: node server/karaoke.mjs   (env: PORT, HOST)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(ROOT, "static");
const DATA_FILE = path.join(ROOT, "queue.json");

// Realistic browser headers; bilibili's public web API rejects unknown clients.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Tracks are keys by `${platform}:${video_id}:p${page}`. */
const state = { current: null, queue: [], history: [], revision: 0 };
const HISTORY_TRACE_LENGTH = 20; // items kept in memory / dedup window
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

function findDuplicate(item) {
  if (state.current?.id === item.id) return state.current;
  return (
    state.queue.find((i) => i.id === item.id) ??
    state.history.slice(0, 10).find((i) => i.id === item.id)
  );
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
    state.history = state.history.slice(0, HISTORY_TRACE_LENGTH);
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

function serveIndex(res) {
  const file = path.join(STATIC_DIR, "index.html");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(file));
}

async function route(req, res) {
  if (handlePreflight(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return serveIndex(res);
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return sendJson(res, 200, publicState());
  }

  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && pathname === "/api/submit") {
    const body = await readJsonBody(req);
    try {
      const parsed = await parseInput(body.input);
      const view = await fetchView(parsed);
      const item = makeItem(view, parsed.page, body.by);
      const dup = findDuplicate(item);
      if (dup) {
        return sendJson(res, 409, {
          ok: false,
          message: `duplicate: "P${item.page} ${item.part || item.title}" is already ${dup.id === state.current?.id ? "playing" : "in the recent list"}`,
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

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

loadState();
promoteNextIfIdle(); // resume jukebox after a restart with a non-empty queue
http
  .createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error("[http]", err);
      sendJson(res, 500, { ok: false, message: "internal error" });
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`[karaoke] queue server on http://${HOST}:${PORT}`);
  });
