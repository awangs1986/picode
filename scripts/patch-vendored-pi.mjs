import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const target = join(
  dirname(sdkEntry),
  "modes",
  "interactive",
  "interactive-mode.js",
);
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
let source = readFileSync(target, "utf8");
let changed = false;

if (source.includes(importOriginal)) {
  source = source.replace(importOriginal, importPatched);
  changed = true;
} else if (!source.includes(importPatched)) {
  throw new Error(
    "Unsupported Pi /import command layout; review the pinned Pi compatibility patch before upgrading.",
  );
}

if (source.includes(cursorOriginal)) {
  source = source.replace(cursorOriginal, cursorPatched);
  changed = true;
} else if (!source.includes("Picode compatibility seam: publish final editor text state")) {
  throw new Error(
    "Unsupported Pi editor onChange layout; review the pinned Pi compatibility patch before upgrading.",
  );
}

if (changed) writeFileSync(target, source, "utf8");
