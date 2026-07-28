---
status: accepted
---

# Version the XML language-pack format

Publish language packs as UTF-8 XML with a BCP 47 language ID, display name, integer schema version, and uniquely keyed plain-text strings. Packs cannot contain HTML, CSS, scripts, or font declarations, and translated placeholders must match the built-in English source placeholders or that key falls back to English. Versioning this intentionally small public format allows user-installed packs to remain compatible across application releases.
