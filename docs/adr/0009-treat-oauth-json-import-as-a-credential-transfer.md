---
status: accepted
---

# Treat OAuth JSON import as a credential transfer

Treat an imported Codex, Claude, or Cursor OAuth JSON credential as a one-time Credential Transfer, never as a live shared credential or a file that Picot Next keeps synchronized. Before import, warn that provider refresh-token rotation may invalidate the source application's login. Recommend an independent OAuth login inside Picot Next for stable coexistence; when a transferred credential expires, require the user to log in or import again manually rather than rereading local files in the background.
