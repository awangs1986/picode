import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPiSubagentsCompatibility } from "./pi-subagents-compatibility.mjs";

const packageEntry = fileURLToPath(import.meta.resolve("pi-subagents"));
applyPiSubagentsCompatibility(dirname(packageEntry));
