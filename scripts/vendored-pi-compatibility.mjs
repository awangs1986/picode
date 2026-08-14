import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const importOriginal = 'if (text === "/import" || text.startsWith("/import ")) {';
const importPatched = 'if (text.startsWith("/import ")) {';
const cursorOriginal = `        this.defaultEditor.onChange = (text) => {
            const wasBashMode = this.isBashMode;
            this.isBashMode = text.trimStart().startsWith("!");
            if (wasBashMode !== this.isBashMode) {
                this.updateEditorBorderColor();
            }
        };`;
const cursorPatched = `        this.defaultEditor.onChange = (text) => {
            const wasBashMode = this.isBashMode;
            this.isBashMode = text.trimStart().startsWith("!");
            if (wasBashMode !== this.isBashMode) {
                this.updateEditorBorderColor();
            }
            // Picode compatibility seam: publish final editor text state without changing Pi behavior.
            const picodeInputListener = globalThis[Symbol.for("picode.input-text-state")];
            if (typeof picodeInputListener === "function") {
                picodeInputListener(text.length > 0);
            }
        };`;
const seedOriginal = `    getSessionFile() {
        return this.sessionFile;
    }
    _persist(entry) {`;
const seedPatched = `    getSessionFile() {
        return this.sessionFile;
    }
    /** Picode compatibility seam: persist an explicit seeded session without a fake assistant turn. */
    persistSessionSeed() {
        if (!this.persist || !this.sessionFile)
            return undefined;
        if (!this.flushed) {
            this._rewriteFile();
            this.flushed = true;
        }
        return this.sessionFile;
    }
    _persist(entry) {`;
const seedTypesOriginal = `    getSessionFile(): string | undefined;
    _persist(entry: SessionEntry): void;`;
const seedTypesPatched = `    getSessionFile(): string | undefined;
    /** Persist an explicit seeded session before its first assistant turn. */
    persistSessionSeed(): string | undefined;
    _persist(entry: SessionEntry): void;`;
const readonlyManagerOriginal = `"getSessionName">;`;
const readonlyManagerPatched = `"getSessionName" | "persistSessionSeed">;`;

function applyPinnedPatch(source, patch) {
  if (source.includes(patch.original)) return source.replace(patch.original, patch.replacement);
  if (source.includes(patch.marker)) return source;
  throw new Error(patch.error);
}

/**
 * The single compatibility interface for Picode's pinned Pi distribution.
 * Each target file is only written after all of its patches validate.
 */
export function applyVendoredPiCompatibility(piDistRoot) {
  const targets = [
    {
      path: join(piDistRoot, "modes", "interactive", "interactive-mode.js"),
      patches: [
        {
          original: importOriginal,
          replacement: importPatched,
          marker: importPatched,
          error: "Unsupported Pi /import command layout; review the pinned Pi compatibility patch before upgrading.",
        },
        {
          original: cursorOriginal,
          replacement: cursorPatched,
          marker: "Picode compatibility seam: publish final editor text state",
          error: "Unsupported Pi editor onChange layout; review the pinned Pi compatibility patch before upgrading.",
        },
      ],
    },
    {
      path: join(piDistRoot, "core", "session-manager.js"),
      patches: [{
        original: seedOriginal,
        replacement: seedPatched,
        marker: "persistSessionSeed()",
        error: "Unsupported Pi SessionManager layout; review the seeded-session compatibility patch before upgrading.",
      }],
    },
    {
      path: join(piDistRoot, "core", "session-manager.d.ts"),
      patches: [
        {
          original: seedTypesOriginal,
          replacement: seedTypesPatched,
          marker: "persistSessionSeed():",
          error: "Unsupported Pi SessionManager type layout; review the seeded-session compatibility patch before upgrading.",
        },
        {
          original: readonlyManagerOriginal,
          replacement: readonlyManagerPatched,
          marker: readonlyManagerPatched,
          error: "Unsupported Pi ReadonlySessionManager layout; review the seeded-session compatibility patch before upgrading.",
        },
      ],
    },
  ];

  let changedFiles = 0;
  let patches = 0;
  for (const target of targets) {
    const original = readFileSync(target.path, "utf8");
    let next = original;
    for (const patch of target.patches) {
      next = applyPinnedPatch(next, patch);
      patches += 1;
    }
    if (next === original) continue;
    writeFileSync(target.path, next, "utf8");
    changedFiles += 1;
  }
  return { changedFiles, patches };
}
