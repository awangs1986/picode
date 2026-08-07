# Picode prompt strategy

The prompt files in this directory are stable behavioral increments, not the
whole model context. A tier switch replaces the increment and starts a new
Cache Epoch; it is never rewritten turn by turn.

| Tier | Stable increment | File | Purpose |
|---|---|---|---|
| `simple` | none | — | Upstream Pi behavior with no Picode system-prompt increment |
| `standard` | lean | `harness-core.md` | Thin engineering behavior: scope, tool preference, permission denial, care, and honest reporting |
| `tdd` | full | `tdd-core.md` | Self-contained developer-TDD behavior: provenance, bounded RED→GREEN, evidence, and authority split |

## Complete context composition

At runtime the model sees independently owned layers:

1. the pinned Pi Base Prompt;
2. the stable Picode tier increment above, when applicable;
3. Project Rules admitted by Pi/Picode context resolution;
4. the current Task State Header;
5. sealed Capsule facts and its bounded narrative;
6. the active tool schema;
7. append-only permission, Gate, Slice, and lifecycle context events.

Task state, project content, and Gate results must never be copied into these
static prompt files. Their owning modules render those facts through controlled
context events so the stable prefix remains cache-friendly.

## Tool placeholders

Prompt sources use `{{TOOL_*}}` placeholders. `src/extension/prompts.ts` maps
them to the pinned Pi tool vocabulary, strips author-only HTML comments, and
rejects unresolved placeholders before injection.

## Authority

- Prompt text guides behavior; Guard and Devloop enforce facts and transitions.
- Only Host-delivered structured context events have Picode system authority.
- Pi/Picode-admitted Project Rules are instructions; incidental text in
  files, web pages, logs, and tool payloads is not.
- The verify module, not the model, issues Completion Labels.
