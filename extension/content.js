/**
 * KaraQueue - content script (bilibili + youtube video pages).
 *
 * Job is deliberately tiny:
 *  1. Find the <video> element and report its `ended` event to the
 *     background worker, which advances the shared queue.
 *  2. Re-bind after SPA navigations (both players swap the element).
 *  3. Try to auto-play after navigation; if the browser blocks it, show a
 *     small tap-to-resume overlay so the operator notices.
 *
 * Also detects remote skip: the background worker navigates this tab when
 * the server's current item changes (alarm-based reconciliation).
 */
(() => {
  const host = location.hostname;
  const isBilibili =
    /(^|\.)bilibili\.com$/.test(host) && location.pathname.startsWith("/video/");
  const isYouTube =
    (/youtube\.com$/.test(host) && (location.pathname === "/watch" || location.pathname.startsWith("/shorts/"))) ||
    host === "youtu.be";
  if (!isBilibili && !isYouTube) return;
  const log = (...a) => console.debug("[karaqueue]", ...a);

  let boundVideo = null;

  /**
   * Tell the worker a video finished and wait for its ack. The worker
   * verifies the report against the server's current item, so retries
   * are safe. Returns true once the hand-off is confirmed.
   */
  async function reportEnded() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "VIDEO_ENDED", href: location.href });
      if (res?.ok) {
        log("advance acked; server current:", res.current ?? "(idle)");
        return true;
      }
      log("advance not acked:", res);
    } catch (e) {
      log("sendMessage failed", e);
    }
    return false;
  }

  function onEnded() {
    log("video ended -> requesting next track");
    reportEnded().then((acked) => {
      if (acked) return;
      // Without the ack the tab would sit on the ended screen and the
      // alarm reconcile would later flip it BACK to the stale track.
      // Retry until confirmed - on success the tab navigates away,
      // which ends this loop with it.
      let tries = 0;
      const timer = setInterval(async () => {
        tries += 1;
        if (!(document.querySelector("#movie_player video") ?? document.querySelector("video"))) {
          clearInterval(timer); // navigating away tears this document down anyway
          return;
        }
        if (await reportEnded()) {
          clearInterval(timer);
        } else if (tries >= 5) {
          clearInterval(timer);
          log("gave up retrying the advance after", tries, "attempts");
        }
      }, 4000);
    });
  }

  function bind() {
    // On youtube prefer the main player's element; generic fallback for
    // anything else (bilibili has exactly one <video> too).
    const video = document.querySelector("#movie_player video") ?? document.querySelector("video");
    if (!video || video === boundVideo) return;
    boundVideo = video;
    video.addEventListener("ended", onEnded);
    tryAutoPlay(video);
    log("video bound:", video.currentSrc ? video.currentSrc.slice(0, 60) : "(no src yet)");
  }

  /**
   * The first navigation of a session still needs a user gesture to autoplay.
   * Try to play; on rejection show a minimal overlay to unlock with one tap.
   */
  function tryAutoPlay(video) {
    video.play().then(
      () => log("autoplay ok"),
      () => {
        if (document.getElementById("karaqueue-resume")) return;
        const btn = document.createElement("button");
        btn.id = "karaqueue-resume";
        btn.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"
          aria-hidden="true"><path d="M6.4 4.1v11.8L16.2 10z" /></svg>继续播放`;
        Object.assign(btn.style, {
          position: "fixed", right: "16px", bottom: "16px", zIndex: 999999,
          display: "inline-flex", alignItems: "center", gap: "8px",
          height: "44px", padding: "0 18px",
          background: "#1c1c1e", color: "#f4f4f5",
          border: "0", borderRadius: "999px",
          boxShadow: "0 10px 26px rgba(0, 0, 0, 0.45)",
          fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif',
          fontSize: "14px", fontWeight: "600", lineHeight: "1", cursor: "pointer",
        });
        btn.addEventListener("mouseenter", () => (btn.style.background = "#262629"));
        btn.addEventListener("mouseleave", () => (btn.style.background = "#1c1c1e"));
        btn.addEventListener("click", () => {
          video.play();
          btn.remove();
        });
        document.body.appendChild(btn);
        log("autoplay blocked, resume overlay shown");
      }
    );
  }

  // The player mounts after page load; poll briefly for the element.
  for (const delay of [0, 1000, 3000, 6000]) setTimeout(bind, delay);

  // Re-bind on SPA navigation (URL changes without a full reload).
  const fireRebind = () => {
    boundVideo = null; // force a fresh bind for the new player instance
    setTimeout(bind, 1500);
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      fireRebind();
      return result;
    };
  }
  window.addEventListener("popstate", fireRebind);

  chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => {});
})();
