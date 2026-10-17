# Nikokara Player

A LAN karaoke queue player prototype: people submit bilibili videos (BV id / link / mobile share text) from their phones, a queue server keeps the order, and a Chrome extension drives a bilibili tab to auto-advance to the next requested track. Zero npm dependencies.

> 🇨🇳 中文说明：[README_zh-sc.md](README_zh-sc.md)

## Current features

- **Input parsing** (bilibili): BV id, av id, full watch URL, `?p=N` multi-part (P) links, `b23.tv` short links, and mobile app share text (`【title】 https://b23.tv/xxx` — the URL is extracted automatically). Each part (P) of a multi-P submission counts as one track (part index is part of the track ID).
- **Queue**: FIFO with requester shown; **a submission while the room is idle starts playing immediately** (promoted to "now playing", all clients follow); the session resumes automatically after a server restart.
- **Dedup**: based on the canonical ID (`bvid + part index`) — resubmitting a track that is playing or queued is rejected (user-facing error message), while re-requesting a played track is allowed.
- **No size caps**: neither the queue nor the play history is truncated.
- **Request page** (mobile): submit form, now playing, and queue; card styles distinguish NOW (blue) / NEXT (amber); play history lives on a secondary page (`#/history`). No skip button on mobile — skipping is the host's job.
- **Extension** (MV3, v0.3.2): auto-advance when a video ends; rebinds the player after SPA navigations; shows a "resume playback" overlay if autoplay is blocked; popup to configure the server address, open the current track, and **skip** (takes effect immediately); NOW/NEXT cards styled like the request page.

## Layout

- `server/karaoke.mjs` — the queue server (Node built-ins only)
- `server/static/index.html` — the single-file, framework-free request page
- `extension/` — the Chrome extension

## Running

Requires **Node >= 18** (built-in fetch).

```sh
node server/karaoke.mjs                      # defaults to 0.0.0.0:7777
PORT=8080 HOST=127.0.0.1 node server/karaoke.mjs
```

Other devices on the LAN use `http://<machine-LAN-IP>:7777` (on macOS, `ipconfig getifaddr en0` shows your IP).

## Installing the extension (Load unpacked)

1. Open `chrome://extensions` in Chrome and enable **Developer mode** (top right)
2. **Load unpacked** → select this repo's `extension/` directory
3. Click the Nikokara Player toolbar icon and confirm the server address (defaults to `http://127.0.0.1:7777`; change it if the server runs on another machine)

## Usage flow

1. Start the queue server on the big-screen machine
2. Open the first video manually in Chrome (or use the popup's "open current track"); **if the browser blocks autoplay, tap the "resume playback" button in the bottom-right corner once** — that is the only interaction needed for the whole session
3. Everyone requests songs from their phones: submissions while idle start playing automatically; when a track ends the extension switches to the next one
4. The host can skip immediately via the popup's skip button; the popup also shows NOW/NEXT cards
5. Want to hear a song again? Find it on the request page's history page and submit it once more

## Notes & known limitations

- **Turn off bilibili's native "auto-play next" toggle**, otherwise the page's own autoplay fights with the extension's switching
- Queue state persists in `server/queue.json` (gitignored); when troubleshooting weird state, `pkill -f karaoke.mjs` and restart, or delete the file for a clean slate
- Video metadata comes from bilibili's public web API; heavy request rates may trigger rate limiting (no throttling in the prototype — fine for a single-room workload)
- Popup skip takes effect immediately via on-demand reconciliation; other remote changes sync within ~15 s via an alarm-based poll
- YouTube / niconico are not supported yet (the resolver reports an error; the source-adapter layer for them is planned)
