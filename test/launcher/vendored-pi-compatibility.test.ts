import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyVendoredPiCompatibility } from "../../scripts/vendored-pi-compatibility.mjs";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

const editorSource = `if (text === "/import" || text.startsWith("/import ")) {
        this.defaultEditor.onChange = (text) => {
            const wasBashMode = this.isBashMode;
            this.isBashMode = text.trimStart().startsWith("!");
            if (wasBashMode !== this.isBashMode) {
                this.updateEditorBorderColor();
            }
        };`;

const managerSource = `    getSessionFile() {
        return this.sessionFile;
    }
    _persist(entry) {`;

const managerTypes = `export type ReadonlySessionManager = Pick<SessionManager, "getSessionName">;
    getSessionFile(): string | undefined;
    _persist(entry: SessionEntry): void;`;

const footerSource = `                const latestPromptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
                latestCacheHitRate =
                    latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
        // Build stats line
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

const runnerSource = `    commandDiagnostics = [];
    staleMessage;
    constructor(extensions, runtime, cwd, sessionManager, modelRegistry) {
    }
    async emit(event) {
        const ctx = this.createContext();
        let result;
        for (const ext of this.extensions) {
            const handlers = ext.handlers.get(event.type);
            if (!handlers || handlers.length === 0)
                continue;
            for (const handler of handlers) {
                try {
                    const handlerResult = await handler(event, ctx);
                    if (this.isSessionBeforeEvent(event) && handlerResult) {
                        result = handlerResult;
                        if (result.cancel) {
                            return result;
                        }
                    }
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack : undefined;
                    this.emitError({
                        extensionPath: ext.path,
                        event: event.type,
                        error: message,
                        stack,
                    });
                }
            }
        }
        return result;
    }
            getSystemPrompt: () => {
                runner.assertActive();
                return runner.getSystemPromptFn();
            },
        };
    }
    createCommandContext() {`;

const extensionTypes = `    /** Get the current effective system prompt. */
    getSystemPrompt(): string;
}`;

describe("vendored Pi compatibility module", () => {
  it("applies every pinned patch atomically per file and is idempotent", async () => {
    await withTempPicodeDir(async (root) => {
      const interactive = join(root, "modes", "interactive", "interactive-mode.js");
      const manager = join(root, "core", "session-manager.js");
      const types = join(root, "core", "session-manager.d.ts");
      const runner = join(root, "core", "extensions", "runner.js");
      const extensionTypeFile = join(root, "core", "extensions", "types.d.ts");
      mkdirSync(join(root, "modes", "interactive"), { recursive: true });
      mkdirSync(join(root, "modes", "interactive", "components"), { recursive: true });
      mkdirSync(join(root, "core"), { recursive: true });
      mkdirSync(join(root, "core", "extensions"), { recursive: true });
      writeFileSync(interactive, editorSource);
      writeFileSync(manager, managerSource);
      writeFileSync(types, managerTypes);
      writeFileSync(join(root, "modes", "interactive", "components", "footer.js"), footerSource);
      writeFileSync(runner, runnerSource);
      writeFileSync(extensionTypeFile, extensionTypes);

      expect(applyVendoredPiCompatibility(root)).toEqual({ changedFiles: 6, patches: 11 });
      expect(applyVendoredPiCompatibility(root)).toEqual({ changedFiles: 0, patches: 11 });
      expect(readFileSync(interactive, "utf8")).toContain("picode.input-text-state");
      expect(readFileSync(manager, "utf8")).toContain("persistSessionSeed()");
      expect(readFileSync(types, "utf8")).toContain('"getSessionName" | "persistSessionSeed"');
      const footer = readFileSync(join(root, "modes", "interactive", "components", "footer.js"), "utf8");
      expect(footer).toContain("Picode keeps lifetime price totals behind /pico-price");
      expect(footer).not.toContain("statsParts.push(`↑");
      expect(readFileSync(runner, "utf8")).toContain("requestNewSession");
      expect(readFileSync(runner, "utf8")).toContain("sessionReplacementBoundary");
      expect(readFileSync(extensionTypeFile, "utf8")).toContain("requestNewSession(options?:");
    });
  });

  it("fails closed when the pinned Pi source layout drifts", async () => {
    await withTempPicodeDir(async (root) => {
      const interactive = join(root, "modes", "interactive", "interactive-mode.js");
      mkdirSync(join(root, "modes", "interactive"), { recursive: true });
      mkdirSync(join(root, "modes", "interactive", "components"), { recursive: true });
      mkdirSync(join(root, "core"), { recursive: true });
      writeFileSync(interactive, "unknown upstream layout");
      writeFileSync(join(root, "core", "session-manager.js"), managerSource);
      writeFileSync(join(root, "core", "session-manager.d.ts"), managerTypes);
      writeFileSync(join(root, "modes", "interactive", "components", "footer.js"), footerSource);

      expect(() => applyVendoredPiCompatibility(root)).toThrow("Unsupported Pi editor onChange layout");
    });
  });
});
