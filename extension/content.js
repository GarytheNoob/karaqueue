/**
 * Nikokara Player - content script (bilibili pages).
 *
 * Job is deliberately tiny:
 *  1. Find the <video> element and report its `ended` event to the
 *     background worker, which advances the shared queue.
 *  2. Re-bind after SPA navigations (bilibili swaps the video element).
 *  3. Try to auto-play after navigation; if the browser blocks it, show a
 *     small tap-to-resume overlay so the operator notices.
 *
 * Also detects remote skip: the background worker navigates this tab when
 * the server's current item changes (alarm-based reconciliation).
 */
(() => {
  if (!location.pathname.startsWith("/video/")) return;
  const log = (...a) => console.debug("[nikokara]", ...a);

  let boundVideo = null;

  function onEnded() {
    log("video ended -> requesting next track");
    chrome.runtime.sendMessage({ type: "VIDEO_ENDED" }).catch((e) => log("sendMessage failed", e));
  }

  function bind() {
    const video = document.querySelector("video");
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
        if (document.getElementById("nikokara-resume")) return;
        const btn = document.createElement("button");
        btn.id = "nikokara-resume";
        btn.textContent = "▶ 继续播放";
        Object.assign(btn.style, {
          position: "fixed", right: "16px", bottom: "16px", zIndex: 999999,
          padding: "10px 18px", borderRadius: "10px", border: "0",
          background: "#2f6fed", color: "#fff", fontSize: "15px", cursor: "pointer",
        });
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
