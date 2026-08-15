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

describe("vendored Pi compatibility module", () => {
  it("applies every pinned patch atomically per file and is idempotent", async () => {
    await withTempPicodeDir(async (root) => {
      const interactive = join(root, "modes", "interactive", "interactive-mode.js");
      const manager = join(root, "core", "session-manager.js");
      const types = join(root, "core", "session-manager.d.ts");
      mkdirSync(join(root, "modes", "interactive"), { recursive: true });
      mkdirSync(join(root, "core"), { recursive: true });
      writeFileSync(interactive, editorSource);
      writeFileSync(manager, managerSource);
      writeFileSync(types, managerTypes);

      expect(applyVendoredPiCompatibility(root)).toEqual({ changedFiles: 3, patches: 4 });
      expect(applyVendoredPiCompatibility(root)).toEqual({ changedFiles: 0, patches: 4 });
      expect(readFileSync(interactive, "utf8")).toContain("picode.input-text-state");
      expect(readFileSync(manager, "utf8")).toContain("persistSessionSeed()");
      expect(readFileSync(types, "utf8")).toContain('"getSessionName" | "persistSessionSeed"');
    });
  });

  it("fails closed when the pinned Pi source layout drifts", async () => {
    await withTempPicodeDir(async (root) => {
      const interactive = join(root, "modes", "interactive", "interactive-mode.js");
      mkdirSync(join(root, "modes", "interactive"), { recursive: true });
      mkdirSync(join(root, "core"), { recursive: true });
      writeFileSync(interactive, "unknown upstream layout");
      writeFileSync(join(root, "core", "session-manager.js"), managerSource);
      writeFileSync(join(root, "core", "session-manager.d.ts"), managerTypes);

      expect(() => applyVendoredPiCompatibility(root)).toThrow("Unsupported Pi editor onChange layout");
    });
  });
});
