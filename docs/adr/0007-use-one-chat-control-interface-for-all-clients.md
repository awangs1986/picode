---
status: accepted
---

# Use one chat control interface for all clients

Route desktop chat operations through the same runtime command-and-event boundary that a future Remote Control Extension will use, including session listing, event observation, message sending, stopping, and explicit continuation. The short-term product will not include a phone interface, pairing, or a remote server, but the desktop UI may not bypass this boundary. This preserves local Pi execution now while preventing the future remote-control add-on from requiring a second chat runtime or a rewrite of the desktop flow.
