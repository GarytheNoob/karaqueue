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
 *  - a <select id="lang"> in the page header switches languages
 *    manually; the choice persists in localStorage (karaqueue:lang)
 *
 * Page contract: the page sets window.I18N_TITLE_KEY (its title key)
 * and may register a re-render hook via setOnLangSwitch(() => {...}).
 */
"use strict";

const I18N_STORAGE_KEY = "karaqueue:lang";
const I18N_FALLBACK = "zh-CN";

/* One entry per translation file; add the new code here when a
   language is added (the <select> options are built from this). */
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

/* Wire the manual switcher, load the initial language, then call
   onReady() so the page starts rendering with translations in place. */
async function initI18n(onReady) {
  const sel = document.getElementById("lang");
  if (sel) {
    for (const { code, label } of I18N_LANGS) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = label;
      sel.appendChild(option);
    }
    sel.value = savedLang() ?? I18N_FALLBACK;
    sel.addEventListener("change", async () => {
      const next = sel.value;
      try {
        const applied = await loadLang(next);
        if (!applied) return; // a newer switch already owns the page
        try {
          localStorage.setItem(I18N_STORAGE_KEY, next);
        } catch {}
      } catch (err) {
        /* Keep the previous language when the pack cannot be loaded. */
        console.warn("[karaqueue] language pack unavailable:", next, err);
        sel.value = i18nLang;
      }
    });
  }

  let initial = (sel ? sel.value : I18N_FALLBACK) ?? I18N_FALLBACK;
  try {
    const saved = savedLang() ?? I18N_FALLBACK;
    initial = saved;
  } catch {}
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
  if (onReady) onReady();
}
