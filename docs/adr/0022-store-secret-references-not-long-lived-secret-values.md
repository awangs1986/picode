---
status: accepted
---

# Store Secret References, not long-lived secret values

Use a protected temporary secret area for one-off work and retain only a Secret Reference for recurring access such as SSH, resolving and injecting the value just in time without exposing it to the model, logs, exports, or ordinary Picode storage. Operating-system credential services are preferred, user-owned files may be referenced with a warning, and Picode destroys only its own temporary material rather than the user's source.
