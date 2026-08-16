import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
const footerLatestCacheOriginal = `                const latestPromptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
                latestCacheHitRate =
                    latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;`;
const footerLatestCachePatched = `                const latestPromptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
                // Picode compatibility seam: retain the latest valid cache hit across zero-usage errors.
                if (latestPromptTokens > 0) {
                    latestCacheHitRate = (entry.message.usage.cacheRead / latestPromptTokens) * 100;
                }`;
const footerStatsOriginal = `        // Build stats line
        const statsParts = [];
        if (usageTotals.input)
            statsParts.push(\`↑\${formatTokens(usageTotals.input)}\`);
        if (usageTotals.output)
            statsParts.push(\`↓\${formatTokens(usageTotals.output)}\`);
        if (usageTotals.cacheRead)
            statsParts.push(\`R\${formatTokens(usageTotals.cacheRead)}\`);
        if (usageTotals.cacheWrite)
            statsParts.push(\`W\${formatTokens(usageTotals.cacheWrite)}\`);
        if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
            statsParts.push(\`CH\${latestCacheHitRate.toFixed(1)}%\`);
        }
        // Kimi Coding is subscription-backed despite using API-key authentication.
        const usingSubscription = state.model
            ? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
            : false;
        if (usageTotals.cost || usingSubscription) {
            const costStr = \`$\${usageTotals.cost.toFixed(3)}\${usingSubscription ? " (sub)" : ""}\`;
            statsParts.push(costStr);
        }`;
const footerStatsPatched = `        // Build stats line. Picode keeps lifetime price totals behind /pico-price.
        const statsParts = [];
        if (latestCacheHitRate !== undefined) {
            statsParts.push(\`CH\${latestCacheHitRate.toFixed(1)}%\`);
        }`;

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
    {
      path: join(piDistRoot, "modes", "interactive", "components", "footer.js"),
      patches: [
        {
          original: footerLatestCacheOriginal,
          replacement: footerLatestCachePatched,
          marker: "Picode compatibility seam: retain the latest valid cache hit",
          error: "Unsupported Pi footer cache layout; review the pinned Pi compatibility patch before upgrading.",
        },
        {
          original: footerStatsOriginal,
          replacement: footerStatsPatched,
          marker: "Picode keeps lifetime price totals behind /pico-price",
          error: "Unsupported Pi footer stats layout; review the pinned Pi compatibility patch before upgrading.",
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
