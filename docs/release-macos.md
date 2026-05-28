# macOS release policy

This project publishes macOS artifacts to intentionally trigger the Gatekeeper
"developer cannot be verified" path (not a damaged app path).

To avoid linker-injected ad-hoc signatures on macOS binaries, this repo sets:

- `.cargo/config.toml` -> `-Wl,-no_adhoc_codesign` for both Apple targets.

## Rules

- Do not ship ad-hoc signatures.
- Do not modify `.app` contents after Tauri bundling.
- Use standard Tauri bundling (`tauri build --bundles dmg`) only.
- Publish the generated `.dmg` directly.

## Release command

```bash
npm run release:mac:dmg
```

The script:

1. Builds DMG via Tauri.
2. Mounts the DMG and inspects the bundled `.app`.
3. Fails if ad-hoc signature is detected.
4. Fails if Gatekeeper reports damaged/invalid sealed resources.
5. Prints Gatekeeper assessment output for release records.

## Expected end-user flow

1. Drag app to `/Applications`.
2. Right-click **Open**.
3. Go to **Privacy & Security**.
4. Click **Open Anyway**.
