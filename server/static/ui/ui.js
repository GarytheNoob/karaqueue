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
 * Component CSS (rows, panels, toasts, drawer, marquee) lives in
 * ui/theme.css, linked by both pages, so nothing is injected at runtime.
 *
 * This file defines the page-agnostic one-liners (esc, fmtDur,
 * titleText, label) as top-level bindings; the pages must NOT redeclare
 * them (classic scripts share one global lexical scope).
 */
"use strict";


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
 *  the hover/reader label. The title runs in a .marquee that never
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
  const run = `<span class="marquee"><span class="run"><span class="ttext">${esc(titleText(item))}${part}</span></span></span>`;
  return `${icon}${run}`;
}

/* Measure each title once per render; only overflowing ones get their
 * hidden duplicate appended plus a data-scroll approval, a single-sweep
 * end offset (the tail of the text lands on the right edge and stays
 * there) and a duration proportional to that distance. Fitting titles
 * never scroll. Devices without hover (phones) toggle the sweep by
 * tapping the title. */
function enhanceMarquee(root = document) {
  root.querySelectorAll(".marquee").forEach((el) => {
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
    el.closest("[data-track]")?.addEventListener("click", (e) => {
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
  const wasOpen = sidebar.classList.contains("open");
  const hadFocus = sidebar.contains(document.activeElement);
  sidebar.classList.toggle("open", open);
  overlay.hidden = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
  // A closed drawer must not keep focusable children in the tab order.
  sidebar.inert = !open;
  if (open && !wasOpen) {
    document.getElementById("sideClose")?.focus();
  } else if (!open && wasOpen && hadFocus) {
    document.getElementById("sideBtn")?.focus();
  }
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
  setSideOpen(false);
  document.getElementById("sideClose").addEventListener("click", () => setSideOpen(false));
  document.getElementById("sideOverlay").addEventListener("click", () => setSideOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setSideOpen(false);
  });
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
