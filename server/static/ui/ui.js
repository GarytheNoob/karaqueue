/**
 * KaraQueue shared UI parts, used by both index.html and admin.html.
 * Loaded after i18n/i18n.js (t(), setOnLangSwitch are already there).
 *
 * Everything here is dependency-free by design:
 *  - platform icons are inline SVG data URIs (no CDN calls from the LAN)
 *  - long titles scroll with a pure CSS loop (paused until hover),
 *    measured once per render by enhanceMarquee()
 *  - showToast() is the page-wide short toast (top, centered bottom)
 *  - initSidebar() wires the LAN-access drawer (same markup both pages)
 *
 * This file defines the page-agnostic one-liners (esc, fmtDur,
 * titleText, label) as top-level bindings; the pages must NOT redeclare
 * them (classic scripts share one global lexical scope).
 */
"use strict";

/* Component CSS for everything below, injected once per page. Page
 * styles stay in the pages; shared component styles live here. */
(function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
  img.picon {
    width: 16px; height: 16px; border-radius: 4px; margin-right: 6px;
    flex: none; align-self: center;
  }
  .tscroll { flex: 1 1 auto; min-width: 0; overflow: hidden; }
  /* The marquee is a single leftward sweep: idle titles render from
   * their start (no attached animation to freeze mid-scroll), and while
   * hovering/tapped the text scrolls once to its end and stops there
   * (fill: forwards) instead of looping. Depends on enhanceMarquee()
   * having approved the element via [data-scroll] — fitting titles
   * never scroll at all. */
  .tscroll .run { display: inline-flex; white-space: nowrap; will-change: transform; }
  .tscroll .run .ttext:not(:last-child) { padding-right: 2.2em; }
  .tscroll[data-scroll]:hover .run, .card.scrolling .tscroll[data-scroll] .run {
    animation: mq var(--mq, 9s) linear 1 forwards;
    animation-play-state: running;
  }
  @keyframes mq { from { transform: translateX(0); } to { transform: translateX(var(--mq-end, -100%)); } }

  .toasts {
    position: fixed; bottom: 18px; left: 0; right: 0; z-index: 60;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto; cursor: pointer;
    background: #1c1c22; border: 1px solid #26262e; border-left: 3px solid #666;
    border-radius: 10px; padding: 9px 14px; color: #e8e8ee; font-size: 13px;
    max-width: 84vw; box-shadow: 0 6px 18px rgba(0,0,0,.45);
    opacity: 0; transform: translateY(8px);
    transition: opacity .18s ease, transform .18s ease;
  }
  .toast.in { opacity: 1; transform: translateY(0); }
  .toast.out { opacity: 0; transform: translateY(8px); }
  .toast.ok { border-left-color: #2fa25c; }
  .toast.fail { border-left-color: #f66; }
  .toast.warn { border-left-color: #e0a33f; }

  /* LAN-access drawer, identical on both pages. */
  .side-btn {
    background: #17171d; border: 1px solid #33333d; color: #ccc;
    border-radius: 8px; padding: 4px 10px; font-size: 14px; cursor: pointer;
  }
  .side-btn:active { background: #26262e; }
  #sideOverlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 40; }
  #sideOverlay[hidden] { display: none; }
  #sidebar {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 41;
    width: min(340px, 86vw); padding: 16px; overflow-y: auto;
    background: #17171d; border-left: 1px solid #33333d;
    transform: translateX(102%); transition: transform .22s ease;
  }
  #sidebar.open { transform: translateX(0); }
  .side-head {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 15px; font-weight: 600; margin-bottom: 6px;
  }
  .side-x {
    background: #26262e; color: #eee; border: 0; border-radius: 8px;
    padding: 4px 12px; font-size: 14px; cursor: pointer; font-weight: 400;
  }
  #sidebar dt { color: #888; font-size: 12px; margin-top: 12px; }
  #sidebar dd { margin: 2px 0 0; font-size: 14px; word-break: break-all; }
  #qrBox {
    display: flex; justify-content: center; margin-top: 16px;
    background: #fff; border-radius: 10px; padding: 10px;
  }
  #qrBox svg { display: block; width: 100%; max-width: 216px; height: auto; }
  .side-hint { color: #888; font-size: 12px; margin: 10px 0 0; line-height: 1.5; }`;
  document.head.appendChild(style);
})();

const PLATFORM_ICONS = {
  bilibili: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='M6.5 1.8 9 4.6M13.5 1.8 11 4.6' stroke='%2323ade5' stroke-width='1.6' stroke-linecap='round'/%3E%3Crect x='1.5' y='4.6' width='17' height='12.2' rx='3.4' fill='%2323ade5'/%3E%3Crect x='6.2' y='8.4' width='2.6' height='4.6' rx='1.3' fill='%23ffffff'/%3E%3Crect x='11.2' y='8.4' width='2.6' height='4.6' rx='1.3' fill='%23ffffff'/%3E%3C/svg%3E",
  youtube: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Crect x='1' y='4' width='18' height='12' rx='3.2' fill='%23ff0033'/%3E%3Cpath d='M8.5 7.6 13.5 10l-5 2.4z' fill='%23ffffff'/%3E%3C/svg%3E",
  unknown: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='8.4' fill='%2326262e'/%3E%3Ctext x='10' y='13.6' font-size='9.5' text-anchor='middle' fill='%23889' font-family='sans-serif'%3E?%3C/text%3E%3C/svg%3E",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDur(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Titles stored server-side may lack metadata (title_missing flag);
 *  each client renders its own localized suffix. */
function titleText(item) {
  return String(item.title ?? "") + (item.title_missing ? t("card.meta_missing") : "");
}

/** One platform glyph or a neutral fallback, with a localized name as
 *  the hover/reader label. The title runs in a .tscroll that never
 *  wraps; enhanceMarquee() appends the hidden duplicate only when the
 *  text overflows, so short titles render as a single clean line. */
function label(item) {
  const known = item.platform === "bilibili" || item.platform === "youtube";
  const key = known ? item.platform : "unknown";
  const name = t(known ? `card.platform_${item.platform}` : "card.platform_unknown");
  const icon = `<img class="picon" src="${PLATFORM_ICONS[key]}" alt="" title="${esc(name)}">`;
  // Multi-part titles read "Title - P2"; single parts stay clean. The
  // suffix lives inside the scrolling text, so it is never squeezed out.
  const part = item.page_count > 1 ? ` - P${item.page}` : "";
  const run = `<span class="tscroll"><span class="run"><span class="ttext">${esc(titleText(item))}${part}</span></span></span>`;
  return `${icon}${run}`;
}

/* Measure each title once per render; only overflowing ones get their
 * hidden duplicate appended plus a data-scroll approval, a single-sweep
 * end offset (the tail of the text lands on the right edge and stays
 * there) and a duration proportional to that distance. Fitting titles
 * never scroll. Devices without hover (phones) toggle the sweep by
 * tapping the title. */
function enhanceMarquee(root = document) {
  root.querySelectorAll(".tscroll").forEach((el) => {
    const run = el.firstElementChild;
    if (!run || run.dataset.marqDone) return;
    run.dataset.marqDone = "1";
    if (run.scrollWidth <= el.clientWidth + 1) return; // fits: keep one copy
    const dup = document.createElement("span");
    dup.className = "ttext";
    dup.setAttribute("aria-hidden", "true");
    dup.textContent = run.firstElementChild.textContent;
    run.appendChild(dup);
    // Sweep once so the very end of the text shows at the right edge,
    // then freeze there (animation fills forwards) until re-triggered.
    const dist = run.scrollWidth - el.clientWidth;
    el.setAttribute("data-scroll", "");
    el.style.setProperty("--mq-end", `${-dist}px`);
    el.style.setProperty("--mq", `${Math.max(6000, Math.round(dist * 22))}ms`);
    el.closest(".card")?.addEventListener("click", (e) => {
      // Touch fallback: no hover, so a tap on the title row toggles it.
      if (!e.target.closest("button") && matchMedia("(hover: none)").matches) {
        e.currentTarget.classList.toggle("scrolling");
      }
    });
  });
}

/* --- Short toasts -----------------------------------------------------
 * Page-wide transient notices. Text is passed in ALREADY translated
 * (t() on this side, a raw server message on that side), so both
 * localized keys and server-composed sentences fit one API. Max 3 on
 * screen, click dismisses, errors linger longer. */
let toastHost = null;
function showToast(type, text) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.id = "toasts";
    toastHost.className = "toasts";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = text;
  type === "fail" ? el.setAttribute("role", "alert") : el.setAttribute("role", "status");
  toastHost.appendChild(el);
  while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add("in"));
  const kill = () => {
    if (!el.isConnected) return;
    el.classList.remove("in");
    el.classList.add("out");
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener("click", kill);
  setTimeout(kill, type === "fail" ? 4500 : 3200);
}

/* --- LAN access sidebar ----------------------------------------------
 * Same drawer on both pages (admin points its QR at the request page,
 * which /api/hostinfo itself decides). Ids are fixed: sideBtn sidebar
 * sideOverlay ssidVal ipVal qrBox. */
let hostData = false; // false = never loaded, null = fetch failed

function setSideOpen(open) {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sideOverlay");
  sidebar.classList.toggle("open", open);
  overlay.hidden = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
}

function renderHostInfo() {
  if (hostData === false) return;
  const host = hostData;
  const primary = host ? (host.primary ?? host.ips?.[0] ?? null) : null;
  document.getElementById("ssidVal").textContent =
    host && host.ssid ? host.ssid : t("side.unavailable");
  document.getElementById("ipVal").textContent =
    host && primary ? `${primary}:${host.port}` : t("side.unavailable");
}

async function loadHostInfo() {
  if (hostData !== false) {
    renderHostInfo(); // a failure re-renders in the current language
    return;
  }
  try {
    hostData = (await (await fetch("/api/hostinfo")).json()).host ?? null;
    if (hostData && typeof qrcode === "function") {
      const primary = hostData.primary ?? hostData.ips?.[0] ?? null;
      if (primary) {
        const qr = qrcode(0, "M"); // EC M: survives camera glare and dents
        qr.addData(`http://${primary}:${hostData.port}/`);
        qr.make();
        document.getElementById("qrBox").innerHTML =
          qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
      }
    }
  } catch {
    hostData = null;
  }
  renderHostInfo();
}

function initSidebar() {
  const btn = document.getElementById("sideBtn");
  if (!btn || !document.getElementById("sidebar")) return;
  document.getElementById("sideClose").addEventListener("click", () => setSideOpen(false));
  document.getElementById("sideOverlay").addEventListener("click", () => setSideOpen(false));
  btn.addEventListener("click", () => {
    setSideOpen(true);
    loadHostInfo();
  });
}

/* Shared per-language-switch re-rendering for the ui.js-owned parts. */
function refreshSidebarI18n() {
  const btn = document.getElementById("sideBtn");
  const close = document.getElementById("sideClose");
  if (btn) btn.setAttribute("aria-label", t("side.btn"));
  if (close) close.setAttribute("aria-label", t("side.close"));
  renderHostInfo();
}
