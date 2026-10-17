# KaraQueue

> Chinese documentation: [README_zh-sc.md](README_zh-sc.md)

A LAN karaoke queue prototype. Guests submit bilibili videos from their phones, a queue server keeps the order, and a Chrome extension drives a bilibili tab to play the next requested track without manual clicks. The server uses only Node built-ins and has no npm dependencies.

## Requesting Tracks

The submit form accepts:

- BV ids and av ids
- full watch URLs and `?p=N` multi-part links
- `b23.tv` short links
- raw mobile share text such as `【title】 https://b23.tv/xxx`, with the URL extracted automatically

Each part (P) of a multi-part submission counts as one track, and the part index becomes part of the track ID.

bilibili throttles the metadata API under load and answers with an HTML page, often with HTTP 412. A submission still succeeds when that happens. The server checks the local cache first and skips the network on a hit, and entries stay valid for 24 hours. Without a cache entry, the track is enqueued link-only and still plays, with the title showing "metadata missing". Rejection happens only when the video id itself is invalid or missing (bilibili codes -400 and -404). Up front, the server fetches `buvid3` and `buvid4` cookies to reduce how often 412 appears.

## Queue and Rules

The queue runs first-in, first-out and shows who requested each track. A submission while the room is idle starts playing immediately: the server promotes it to now playing, and every client follows. After a server restart, the session resumes.

Deduplication uses a canonical id, `bvid` plus the part index. Resubmitting a track that is playing or queued fails with a plain-language Chinese error, while a played track can be requested again. Neither the queue nor the history has a size limit.

Every guest can withdraw their own requests at any time. A green "mine" badge marks each track the browser requested across now playing, the queue, and the history, and queued tracks carry an "✕ withdraw" button. The server enforces ownership by browser uid, independent of the fair-rotation toggle. Withdrawing a queued track also releases that guest's fair-rotation slot.

Every change travels over SSE (server-sent events): submit, skip, delete, reorder, and rule toggles. Measured latency is about 20 ms. Mobile browsers freeze background tabs and drop SSE connections, so each page re-syncs on refocus and polls every 5 seconds while visible.

## Request Page

The request page opens on a phone and holds the submit form, now playing, and the queue. A second page holds the played history, oldest first with sequence numbers, where 1 is the first song of the night. Track cards use blue for NOW and amber for NEXT.

The mobile page has no skip button. Skipping is the host's job.

## Chrome Extension

The extension uses Manifest V3 and drives the big-screen browser.

- Auto-advance when a video ends, by watching the `ended` event on `<video>` and rebinding after single-page navigations.
- Show a "resume playback" overlay in the bottom-right corner when the browser blocks autoplay; one tap covers the whole session.
- Provide a popup that configures the server address, opens the current track, and skips the current track immediately. Its NOW/NEXT cards match the request page. A bad address produces a plain-language error instead of a raw JSON parse failure.

## Admin Console

The admin console runs on a separate port, opens on a phone, and targets the host.

- skip the current track immediately
- delete a queued track
- reorder one step up or down, or jump to the top with the "⤒" button
- re-request any entry in the played history, which carries sequence numbers

Two room rules are toggles:

- Allow the same track in the queue more than once. By default, the server rejects a duplicate of a playing or queued track; enabling it lets guests stack the same song.
- Fair rotation, one song per guest. When on, a guest may hold at most one track that is playing or queued. Matching uses a browser cookie that survives nickname edits and reloads. A locked guest sees a greyed-out submit button and a locked nickname input until their song finishes.

Set `ADMIN_PIN` to require a PIN for every admin read and mutation.

## Layout

- `server/karaoke.mjs`: the queue server, Node built-ins only
- `server/static/index.html`: the request page
- `server/static/admin.html`: the admin console
- `extension/`: the Chrome extension

Both pages are single-file and framework-free.

Server API quick reference, for tinkering:

- Public reads: `GET /` (page), `GET /api/state`, `GET /api/events` (SSE)
- Public writes: `POST /api/submit` `{input, by, uid}`, `POST /api/withdraw` `{id, uid}`, `POST /api/advance`, `POST /api/skip`
- Admin reads: `GET /` (console), `GET /api/state`, `GET /api/events`, `GET /api/config`
- Admin writes: `POST /api/config` `{allowQueuedDuplicates, oneSongPerGuest}`, `POST /api/skip`, `POST /api/delete` `{id}`, `POST /api/reorder` `{id, direction: up|down|top}`, `POST /api/rerequest` `{id}`

## Running

The server requires Node 18 or newer for the built-in fetch.

```sh
node server/karaoke.mjs                      # listens on 0.0.0.0:7777 by default
PORT=8080 HOST=127.0.0.1 node server/karaoke.mjs
```

Devices on the LAN use `http://<machine-LAN-IP>:7777`. On macOS, `ipconfig getifaddr en0` prints the machine IP.

Environment variables:

- `PORT`: server port, default 7777
- `HOST`: bind address
- `ADMIN_PORT`: admin console port, default 7778
- `ADMIN_PIN`: protect the admin console
- `KARAQUEUE_VIEW_API` and `KARAQUEUE_SPI_API`: override the bilibili endpoints for testing

## Installing the Extension

1. Open `chrome://extensions` in Chrome and enable Developer mode in the top right.
2. Choose Load unpacked and select this repository's `extension/` directory.
3. Click the KaraQueue toolbar icon and confirm the server address. It defaults to `http://127.0.0.1:7777`; change it when the server runs on another machine, then save.

## Usage Flow

1. Start the queue server on the big-screen machine.
2. Open the first video in Chrome, either by hand or through the popup's "open current track". If the browser blocks autoplay, tap "resume playback" once in the bottom-right corner. The session needs no further interaction.
3. Guests request songs from their phones. A submission while the room is idle starts playing. When a track ends, the extension switches to the next one.
4. The host can skip, delete, reorder, pin, or re-request a played track at any time, from the popup or the admin console.
5. A guest who wants to hear a song again finds it in the played history on the request page and submits it once more.

## Troubleshooting

- `TypeError: Failed to fetch` in the popup: nothing answered at the configured address. Check that the server runs on the host machine (`node server/karaoke.mjs`) and that the address is reachable. Open `http://<host-ip>:7777/api/state` in a browser; a JSON blob confirms the server is up.
- `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`: the configured address returned an HTML page instead of KaraQueue's JSON. A missing `:7777` port is almost always the cause, which sends the request to another web service on port 80 such as a router admin page. The address must look like `http://192.168.1.5:7777`.
- Guests do not need the extension. It only drives the big-screen browser; phones request songs at `http://<host-ip>:7777`.
- A page looks stale after a skip or another change: mobile browsers freeze background tabs and drop the SSE connection. Each page re-syncs on refocus and polls every 5 seconds while visible, so bring the tab back to the foreground.

## Notes

- Turn off bilibili's native "auto-play next" toggle. Otherwise the page's own autoplay competes with the extension's switching.
- Queue state lives in `server/queue.json` and the metadata cache in `server/meta-cache.json`; both are gitignored. For odd state, run `pkill -f karaoke.mjs` and restart, or delete both files to reset everything.
- The popup skip takes effect immediately through on-demand reconciliation. Other remote changes sync through an alarm-based poll every 15 seconds.
- YouTube and niconico are not supported yet. The resolver reports an error, which is expected; the source-adapter layer is planned.
- **Disclaimer**: this project is not affiliated with bilibili. Videos always play through bilibili's official web player, and the server fetches public metadata only to display titles.
