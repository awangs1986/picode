# Rename the product to Picode without moving Picot data

The user-visible product, executable, installer, and UI strings are renamed from Picot to Picode. The Tauri identifier, Pi provider/session formats, `picot-*` file extensions, `pistudio` settings key, locale storage key, and account-vault keyring service remain unchanged so existing sessions, backups, settings, and credentials continue to load. Automatic upstream Picot update endpoints are removed until Picode has its own published fork and signing key.
