# KaraQueue

> 🇨🇳 中文说明：[README_zh-sc.md](README_zh-sc.md)

A LAN karaoke queue player prototype: people submit bilibili videos (BV id / link / mobile share text) from their phones, a queue server keeps the order, and a Chrome extension drives a bilibili tab to auto-advance to the next requested track. Zero npm dependencies.

## Feature overview

**Requesting (bilibili)**

- Input formats: BV id, av id, full watch URL, `?p=N` multi-part links, `b23.tv` short links, and raw mobile share text (`【title】 https://b23.tv/xxx` — the URL is extracted automatically). Each part (P) of a multi-P submission counts as one track (part index is part of the track ID).
- **Risk-control tolerance**: when bilibili throttles/block the metadata API (e.g. HTTP 412 returning an HTML page), submissions still succeed — cached metadata is used first (24 h TTL, zero network on cache hits); without cache the track is enqueued link-only and plays fine (title shows "metadata missing"). Only genuinely invalid/missing videos (bilibili codes -400/-404) are rejected. `buvid3/buvid4` cookies are fetched up front to reduce 412 exposure.

**Queue & rules**

- FIFO queue with the requester shown; **a submission while the room is idle starts playing immediately** (promoted to "now playing", all clients follow). The session resumes automatically after a server restart.
- Dedup by canonical ID (`bvid + part index`): resubmitting a playing/queued track is rejected with a human-readable Chinese error; re-requesting a played track is always allowed. No size caps on the queue or history.
- Real-time sync: every change (submit/skip/delete/reorder/rule toggle) is broadcast instantly (~20 ms measured) to all pages over SSE, with a 5 s polling + on-refocus reconciliation fallback for frozen mobile tabs.

**Request page** (phones)

- Submit form, now playing, queue, and "played history" on a secondary page (oldest first with sequence numbers, 1 = first song ever played). Track cards distinguish NOW (blue) / NEXT (amber). No skip button on mobile — skipping is the host's job.

**Chrome extension** (MV3, drives the big screen)

- Auto-advance when a video ends (watches `<video>` `ended`, rebinds after SPA navigations).
- Tap-to-resume overlay when the browser blocks autoplay on first navigation.
- Popup: configure server address, open the current track, **skip** (immediate), and NOW/NEXT cards styled like the request page. Bad addresses produce plain-language errors instead of raw JSON parse failures.

**Admin console** (separate port, phone-friendly, for the host)

- Skip the current track (immediate), delete queued tracks, fine-grained reorder (up/down) **plus a one-tap "take to top" (⤒) button**.
- Play history list with sequence numbers and a **one-tap "request again"** button (re-enqueues a played track; an idle room starts playing it immediately).
- Room rule toggles: "allow the same track in the queue multiple times" (off: duplicates of queued/playing tracks are rejected; on: guests may stack the same song), and **"fair rotation — one song per guest"** (on: a guest may have at most one track playing or queued at a time, matched by a browser cookie that survives nickname edits and reloads; locked guests see a greyed-out submit button and a locked nickname input on the request page until their song finishes).
- Optional `ADMIN_PIN` gates all admin reads/mutations.

## Layout

- `server/karaoke.mjs` — the queue server (Node built-ins only)
- `server/static/index.html` — the request page; `server/static/admin.html` — the admin console (both single-file, framework-free)
- `extension/` — the Chrome extension

Server API quick reference (for tinkering):

- Public port: `GET /` (page), `GET /api/state`, `GET /api/events` (SSE), `POST /api/submit` `{input, by, uid}`, `POST /api/advance`, `POST /api/skip`
- Admin port: `GET /` (console), `GET /api/state`, `GET /api/events`, `GET /api/config`, `POST /api/config` `{allowQueuedDuplicates, oneSongPerGuest}`, `POST /api/skip`, `POST /api/delete` `{id}`, `POST /api/reorder` `{id, direction: up|down|top}`, `POST /api/rerequest` `{id}`

## Running

Requires **Node >= 18** (built-in fetch).

```sh
node server/karaoke.mjs                      # defaults to 0.0.0.0:7777
PORT=8080 HOST=127.0.0.1 node server/karaoke.mjs
```

Other devices on the LAN use `http://<machine-LAN-IP>:7777` (on macOS, `ipconfig getifaddr en0` shows your IP).

Environment variables: `PORT` (server, default 7777), `HOST` (bind address), `ADMIN_PORT` (console, default 7778), `ADMIN_PIN` (protect the console). `KARAQUEUE_VIEW_API` / `KARAQUEUE_SPI_API` override bilibili endpoints for testing.

## Admin console

Start the server and open `http://<machine-LAN-IP>:7778` on the host's phone:

```sh
node server/karaoke.mjs
# => [karaqueue] queue server on http://0.0.0.0:7777
# => [karaqueue] admin console on http://0.0.0.0:7778 (no PIN set (ADMIN_PIN env to protect))
```

Set `ADMIN_PIN=xxxx` to require a PIN for all console reads/mutations (the page stores it on the phone). Without it, anyone on the LAN can use the console — enabling it on shared Wi-Fi is recommended.

## Installing the extension (Load unpacked)

1. Open `chrome://extensions` in Chrome and enable **Developer mode** (top right)
2. **Load unpacked** → select this repo's `extension/` directory
3. Click the KaraQueue toolbar icon and confirm the server address (defaults to `http://127.0.0.1:7777`; change it if the server runs on another machine)

## Usage flow

1. Start the queue server on the big-screen machine
2. Open the first video manually in Chrome (or use the popup's "open current track"); **if the browser blocks autoplay, tap the "resume playback" button in the bottom-right corner once** — that is the only interaction needed for the whole session
3. Everyone requests songs from their phones: submissions while idle start playing automatically; when a track ends the extension switches to the next one
4. The host can skip immediately via the popup or the admin console, delete/reorder/pin the queue, and re-request played tracks with one tap
5. Guests can re-hear a song via the request page's history page (find it and submit again)

## Troubleshooting

- **`TypeError: Failed to fetch`** in the popup: nothing answered at the configured address — is the queue server actually running (`node server/karaoke.mjs` on the *host* machine), and is the address reachable? Test by opening `http://<host-ip>:7777/api/state` in a browser; you should see a JSON blob.
- **`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`**: the configured address returned an HTML page instead of KaraQueue's JSON — almost always a missing `:7777` port (hitting some other web service on port 80, e.g. a router admin page). The address must look like `http://192.168.1.5:7777`.
- **Guests do not need the extension at all.** The extension only drives the big-screen browser. Phones request songs at `http://<host-ip>:7777`.
- A page looks stale after skip/state changes: mobile browsers freeze background tabs and drop SSE connections; our pages re-sync on refocus and poll every 5 s while visible, so just bring the tab back to the foreground.

## Notes & known limitations

- **Turn off bilibili's native "auto-play next" toggle**, otherwise the page's own autoplay fights with the extension's switching
- Queue state persists in `server/queue.json`, metadata cache in `server/meta-cache.json` (both gitignored); when troubleshooting weird state, `pkill -f karaoke.mjs` and restart, or delete both files for a clean slate
- Popup skip takes effect immediately via on-demand reconciliation; other remote changes sync within ~15 s via an alarm-based poll
- YouTube / niconico are not supported yet (the resolver reports an error; the source-adapter layer for them is planned)
- **Disclaimer**: not affiliated with bilibili; videos always play through bilibili's official web player, and the server only fetches public metadata to display titles.
