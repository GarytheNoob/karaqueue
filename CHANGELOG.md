# Changelog

All notable changes to KaraQueue are documented here. The project follows
[Semantic Versioning](https://semver.org/) and the format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] - 2026-11-25

### Added

- Windows host support: Wi-Fi SSID lookup through `netsh`, Windows system
  proxy detection from the registry, and state-file write retries around
  transient antivirus/indexer locks.
- YouTube duration metadata: the server asks the keyless InnerTube player
  endpoint first and falls back to the watch page. Missing durations are no
  longer cached as zero, existing queue and history entries are backfilled
  on startup, and the extension reports the player's real `video.duration`
  during playback.
- Remaining queue time on the request page, shown beside the queue count.
- Admin history tools: export played history as a UTF-8 CSV
  (`status,requested_by,url,title`, with BOM and CRLF), and clear history
  through an inline two-step confirmation. Both controls are available only
  on the admin port (7778).

### Changed

- Moved the request-rule switches above the queue and history lists in the
  admin console.
- Startup logs now show `http://127.0.0.1:...` instead of the unroutable
  `0.0.0.0`/`::` bind address.
- The extension manifest and `package.json` are both 1.1.0.

### Fixed

- b23 short-link expansion now validates the real hostname and limits every
  redirect hop to Bilibili domains, closing a server-side request forgery
  path.
- Concurrent `VIDEO_ENDED` reports are serialized in the extension and
  guarded by an expected current track id on the server, so duplicate
  reports can no longer skip the next queued song.
- YouTube bot walls no longer leave durations stuck at zero; the player
  endpoint and the extension's real-duration report provide fallbacks.
- The LAN QR code prefers physical Wi-Fi/Ethernet interfaces over VPN and
  virtual adapters.
- Windows state saves retry atomic renames after transient `EPERM`/`EACCES`
  locks.

### Upgrade notes

- Restart the server after upgrading; old YouTube queue and history entries
  backfill their durations in the background.
- Reload the extension from the 1.1.0 release zip to get duration reporting
  and the duplicate-ended-report guard.
- History export and clear are admin-only; the public request page remains
  read-only.

[1.1.0]: https://github.com/GarytheNoob/karaqueue/compare/v1.0.0...v1.1.0
