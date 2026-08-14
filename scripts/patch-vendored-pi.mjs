import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyVendoredPiCompatibility } from "./vendored-pi-compatibility.mjs";

const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
applyVendoredPiCompatibility(dirname(sdkEntry));
