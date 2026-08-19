import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPiWebAccessCompatibility } from "./pi-web-access-compatibility.mjs";

const packageEntry = fileURLToPath(import.meta.resolve("pi-web-access/gemini-search.ts"));
applyPiWebAccessCompatibility(dirname(packageEntry));
