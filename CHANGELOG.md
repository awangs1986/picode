# Changelog

## 0.2.0 — Embedded pi runtime

Pi Studio now ships a known-good build of the `pi` agent runtime inside the .app bundle. The "mirror server" / browser extension distribution path is dropped.

### Highlights

- **Embedded pi binary.** `scripts/fetch-pi-binary.js` downloads a pinned `pi-mono` release tarball into `src-tauri/resources/pi/` at build time. The Tauri bundle includes that tree; the Rust process manager spawns it directly. No PATH discovery, no version mismatch between Pi Studio and the agent it talks to.
- **Pinned version.** The embedded pi version lives in `scripts/pi-version.json` and is forwarded to the UI via `PI_STUDIO_PI_VERSION`. Bumping is an explicit, reviewable change.
- **Isolated from user-installed pi.** A `pi` on the user's `$PATH` (if any) is never consulted. Sessions, auth, and settings under `~/.pi/agent/` are still shared, so credentials set up via `pi /login` Just Work in Pi Studio.
- **No more mirror / extension mode.** The `pi install npm:pi-studio` distribution path, basic auth, QR / Tailscale advertising, and `/studiostart` / `/studiostop` commands are removed. Pi Studio is desktop-only.

### Breaking changes

- The `pi install npm:pi-studio` install path is gone. Use the desktop installer.
- Mobile / remote browser access (Tailscale + QR + basic auth) is removed. Pi Studio's HTTP server now binds only to `127.0.0.1`.
- `extensions/mirror-server.ts` has been renamed to `extensions/embedded-server.ts`. The `imessage-bridge` extension is removed.
- `cmd_get_pi_version` now returns the pinned version from `scripts/pi-version.json` instead of invoking `pi --version` on the system PATH.
- Removed login-shell environment harvesting on macOS. If you launch Pi Studio from Finder/Dock and only have your API key exported in `~/.zshrc` (never run `pi /login`), Pi Studio will no longer pick it up automatically. Run `pi /login` once or write `~/.pi/agent/auth.json` directly to fix.
