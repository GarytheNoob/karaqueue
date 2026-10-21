/**
 * KaraQueue i18n core, shared by index.html and admin.html.
 *
 * Framework-free, dependency-free:
 *  - one translation file per language under static/i18n/<lang>.json,
 *    served by the server at /i18n/<lang>.json (flat key -> string map)
 *  - static markup carries `data-i18n` (textContent),
 *    `data-i18n-placeholder` and `data-i18n-title`
 *  - strings built in JS go through t(key, vars); `{var}` placeholders
 *    are substituted from vars
 *  - a segmented control in the page header switches languages
 *    manually; the choice persists in localStorage (karaqueue:lang)
 *
 * Page contract: the page sets window.I18N_TITLE_KEY (its title key)
 * and may register a re-render hook via setOnLangSwitch(() => {...}).
 */
"use strict";

const I18N_STORAGE_KEY = "karaqueue:lang";
const I18N_FALLBACK = "zh-CN";

/* One entry per translation file; add the new code here when a
   language is added. The switcher's display order is set separately,
   below, and is independent of this list. */
const I18N_LANGS = [
  { code: "zh-CN", label: "中文" },
  { code: "en", label: "English" },
  { code: "zh-Hant", label: "繁體中文" },
];

/* Copy of the active language (populated by loadLang). Before it
   arrives, t() returns the raw key — pages therefore start their main
   logic from the initI18n(onReady) callback. */
let i18nDict = {};
let i18nLang = I18N_FALLBACK;

/* Sequential guard: when two loads race (fast double-switch on a slow
   network), only the latest-issued one may apply. */
let loadLangSeq = 0;

/* Per-page hook, runs after a successful (re)load so dynamic markup
   built with t() is rebuilt in the current language. */
let onLangSwitch = null;
function setOnLangSwitch(fn) {
  onLangSwitch = fn;
}

function t(key, vars) {
  const raw = i18nDict[key] ?? key;
  if (!vars) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (m, name) =>
    name in vars ? String(vars[name]) : "",
  );
}

/* Replace the translated strings in the static part of the page. */
function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}

async function loadLang(lang) {
  const seq = ++loadLangSeq;
  const res = await fetch(`i18n/${lang}.json`, { cache: "no-cache" });
  if (seq !== loadLangSeq) return false; // superseded by a newer switch
  if (!res.ok) throw new Error(`i18n/${lang}.json: HTTP ${res.status}`);
  const dict = await res.json();
  if (seq !== loadLangSeq) return false; // superseded while parsing
  if (typeof dict !== "object" || dict === null || Array.isArray(dict)) {
    throw new Error(`i18n/${lang}.json: not a string map`);
  }
  i18nDict = dict;
  i18nLang = lang;
  document.documentElement.lang = lang;
  if (window.I18N_TITLE_KEY) document.title = t(window.I18N_TITLE_KEY);
  applyI18n();
  if (onLangSwitch) onLangSwitch();
  return true;
}

function savedLang() {
  try {
    const saved = localStorage.getItem(I18N_STORAGE_KEY);
    return saved && I18N_LANGS.some((l) => l.code === saved) ? saved : null;
  } catch {
    return null;
  }
}

/* --- Segmented language switcher -------------------------------------
 * A sliding thumb (En | 简 | 繁) instead of a system <select>. Captions
 * are fixed glyphs - localizing the control that changes the language
 * makes no sense. Display order below is fixed by design, independent
 * of I18N_LANGS registration order. The control's CSS lives in
 * ui/theme.css; I18N_SWITCH_WIDTH must match it. */
const I18N_SWITCH_ORDER = ["en", "zh-CN", "zh-Hant"];
const I18N_SWITCH_CAPTION = { en: "En", "zh-CN": "简", "zh-Hant": "繁" };
const I18N_SWITCH_WIDTH = 36; // px per segment, mirrors the CSS

function renderLangSwitch(host, active) {
  if (!host.firstElementChild) {
    host.className = "lang-switch";
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", "Language");
    const thumb = document.createElement("span");
    thumb.className = "ls-thumb";
    host.appendChild(thumb);
    for (const code of I18N_SWITCH_ORDER) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.code = code;
      b.textContent = I18N_SWITCH_CAPTION[code];
      b.addEventListener("click", () => switchLang(code));
      host.appendChild(b);
    }
  }
  const idx = Math.max(0, I18N_SWITCH_ORDER.indexOf(active));
  host.querySelector(".ls-thumb").style.transform = `translateX(${idx * I18N_SWITCH_WIDTH}px)`;
  host.querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.code === active)));
}

/* Shared switch flow for every control: load the pack, persist the
   choice, and re-point the highlight at the language that is actually
   active - on a failed pack the previous language stays put. */
async function switchLang(next) {
  try {
    const applied = await loadLang(next);
    if (!applied) return; // a newer switch already owns the page
    try {
      localStorage.setItem(I18N_STORAGE_KEY, next);
    } catch {}
  } catch (err) {
    /* Keep the previous language when the pack cannot be loaded. */
    console.warn("[karaqueue] language pack unavailable:", next, err);
  }
  renderLangSwitch(document.getElementById("langSwitch"), i18nLang);
}

/* Wire the manual switcher, load the initial language, then call
   onReady() so the page starts rendering with translations in place. */
async function initI18n(onReady) {
  let initial = I18N_FALLBACK;
  try {
    initial = savedLang() ?? I18N_FALLBACK;
  } catch {}

  const sw = document.getElementById("langSwitch");
  if (sw) {
    renderLangSwitch(sw, initial);
  } else {
    // Legacy pages without the switcher keep the old <select>.
    const sel = document.getElementById("lang");
    if (sel) {
      for (const { code, label } of I18N_LANGS) {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = label;
        sel.appendChild(option);
      }
      sel.value = initial;
      sel.addEventListener("change", async () => {
        try {
          const applied = await loadLang(sel.value);
          if (!applied) return;
          try {
            localStorage.setItem(I18N_STORAGE_KEY, sel.value);
          } catch {}
        } catch (err) {
          console.warn("[karaqueue] language pack unavailable:", sel.value, err);
          sel.value = i18nLang;
        }
      });
    }
  }

  try {
    await loadLang(initial);
  } catch (err) {
    console.warn("[karaqueue] falling back to", I18N_FALLBACK, err);
    try {
      await loadLang(I18N_FALLBACK);
    } catch (err2) {
      /* Static Chinese markup keeps the page usable either way. */
      console.warn("[karaqueue] no language pack loaded", err2);
    }
  }
  if (sw) renderLangSwitch(sw, i18nLang);
  if (onReady) onReady();
}
