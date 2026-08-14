import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import stickyInputExtension from "../../vendor/pi-sticky-input/index.ts";

/**
 * UI-only Pi extensions that must register before the first session_start.
 * They are not model capabilities and therefore do not enter Guard's catalog
 * or the active tool schema.
 */
export function registerBundledDefaultExtensions(pi: ExtensionAPI): void {
  stickyInputExtension(pi);
}
