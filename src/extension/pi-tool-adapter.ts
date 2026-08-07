import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActiveToolAdapter } from "../engine/activation.ts";
import type { CapabilityManifest, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

/**
 * Pin-version seam for Pi 0.84 active tools. Capability discovery remains in
 * Guard; this adapter only translates an admitted capability into Pi tool names.
 */
export class PiActiveToolAdapter implements ActiveToolAdapter {
  private readonly toolsByCapability = new Map<string, readonly string[]>();

  constructor(private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {}

  bind(capabilityId: string, toolNames: readonly string[]): void {
    this.toolsByCapability.set(capabilityId, [...new Set(toolNames)]);
  }

  /** Keep only vendor tools belonging to the current tier; native/user tools survive. */
  reconcile(capabilityIds: readonly string[]): void {
    const allVendorTools = new Set([...this.toolsByCapability.values()].flat());
    const active = new Set(this.pi.getActiveTools().filter((name) => !allVendorTools.has(name)));
    for (const capabilityId of capabilityIds) {
      for (const tool of this.toolsByCapability.get(capabilityId) ?? []) active.add(tool);
    }
    this.pi.setActiveTools([...active]);
  }

  async register(manifest: CapabilityManifest): Promise<Result<void>> {
    const tools = this.toolsByCapability.get(manifest.id);
    if (tools === undefined || tools.length === 0) {
      return err(
        "engine/capability-not-loaded",
        `capability ${manifest.id} has no loaded Pi tools; reload its extension before activation`,
      );
    }
    const active = new Set(this.pi.getActiveTools());
    for (const tool of tools) active.add(tool);
    this.pi.setActiveTools([...active]);
    return ok(undefined);
  }

  async deactivate(capabilityId: string): Promise<Result<void>> {
    const tools = this.toolsByCapability.get(capabilityId);
    if (tools === undefined) {
      return err("engine/capability-not-loaded", `capability ${capabilityId} has no Pi tool mapping`);
    }
    const removed = new Set(tools);
    this.pi.setActiveTools(this.pi.getActiveTools().filter((name) => !removed.has(name)));
    return ok(undefined);
  }
}
