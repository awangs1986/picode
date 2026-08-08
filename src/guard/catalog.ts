import { createHash } from "node:crypto";
import type {
  CapabilityManifest,
  CapabilityRecord,
  CapabilitySettingsRecord,
  CapabilitySettingState,
  PersistedCapabilitySettings,
  Result,
} from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

/**
 * 能力目录（MODULES.md §2.4，R3 两轴正交）。
 *
 * 设置轴 Disabled → Enabled → Trusted 持久化且仅用户可改；
 * 模型只能经 search_tools 搜索（结果按设置轴过滤 = 三级不可见的执行点）
 * 和请求 Activate（前置检查 Enabled + Trusted）。
 *
 * 会话运行轴（Activate/Running）不在这里——那是 Engine 的租约。
 * 持久化读写经 Store 的原子写纪律，由组合根接线。
 */
export class CapabilityCatalog {
  private records = new Map<string, CapabilityRecord>();

  register(manifest: CapabilityManifest, setting: CapabilitySettingState = "disabled"): void {
    const manifestDigest = digestManifest(manifest);
    const settings: CapabilitySettingsRecord = {
      enabled: setting !== "disabled",
      ...(setting === "trusted" ? { trustedDigest: manifestDigest } : {}),
    };
    this.records.set(manifest.id, { manifest, setting, settings, manifestDigest });
  }

  /** 仅用户路径可调用（TUI 设置/首次引导/CLI）；模型不可达 */
  userSetState(capabilityId: string, setting: CapabilitySettingState): Result<void> {
    const record = this.records.get(capabilityId);
    if (!record) return err("guard/capability-unknown", `no capability: ${capabilityId}`);
    if (setting === "disabled") {
      record.settings.enabled = false;
    } else {
      record.settings.enabled = true;
      if (setting === "trusted") record.settings.trustedDigest = record.manifestDigest;
    }
    refreshSetting(record);
    return ok(undefined);
  }

  /**
   * search_tools 的查询本体。disabled（三级）不出现在结果里——
   * 模型完全不可见，而不是"搜到但标灰"。
   */
  search(query: string): CapabilityManifest[] {
    const needle = query.trim().toLowerCase();
    const visible = [...this.records.values()].filter((r) => r.setting !== "disabled");
    if (needle === "") return visible.map((r) => r.manifest);
    return visible
      .filter((r) => {
        const haystack = [r.manifest.id, r.manifest.title, r.manifest.summary, ...r.manifest.keywords]
          .join(" ")
          .toLowerCase();
        return needle.split(/\s+/).every((word) => haystack.includes(word));
      })
      .map((r) => r.manifest);
  }

  /** Activate 前置检查：必须 Enabled + Trusted（本目录里即 trusted 态） */
  checkActivatable(capabilityId: string): Result<void> {
    const record = this.records.get(capabilityId);
    if (!record || record.setting === "disabled") {
      // 对模型而言 disabled 能力不存在；报错不泄露其存在性
      return err("guard/capability-unknown", `no capability: ${capabilityId}`);
    }
    if (record.setting !== "trusted") {
      return err(
        "guard/capability-not-trusted",
        `capability ${capabilityId} is enabled but not trusted; user must trust it in settings`,
      );
    }
    return ok(undefined);
  }

  get(capabilityId: string): CapabilityRecord | undefined {
    return this.records.get(capabilityId);
  }

  /** User-facing settings projection; never exposes runtime leases or secrets. */
  list(): CapabilityRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  removeByOrigin(origin: CapabilityManifest["origin"]): void {
    for (const [id, record] of this.records) {
      if (record.manifest.origin === origin) this.records.delete(id);
    }
  }

  /**
   * 当前规范语义 → live 能力（P3-B，R3 拆分中 Guard 的那一半）：
   * ImportCompiler 只到语义 ID 为止；语义 ID 落到当前哪个工具由这里裁决。
   * 只返回 trusted 的能力（对模型可直接建议的才算 live）。
   */
  resolveLive(semanticOperation: string): CapabilityManifest | undefined {
    for (const record of this.records.values()) {
      if (record.setting !== "trusted") continue;
      if (record.manifest.semanticOperations?.includes(semanticOperation)) {
        return record.manifest;
      }
    }
    return undefined;
  }

  /** 持久化投影（组合根经 Store 落盘） */
  toJSON(): PersistedCapabilitySettings[] {
    return [...this.records.values()].map((r) => ({
      id: r.manifest.id,
      enabled: r.settings.enabled,
      ...(r.settings.trustedDigest === undefined
        ? {}
        : { trustedDigest: r.settings.trustedDigest }),
    }));
  }

  restoreSettings(
    saved: Array<PersistedCapabilitySettings | { id: string; setting: CapabilitySettingState }>,
  ): void {
    for (const item of saved) {
      const record = this.records.get(item.id);
      if (!record) continue;
      if ("setting" in item) {
        record.settings.enabled = item.setting !== "disabled";
        if (item.setting === "trusted") {
          record.settings.trustedDigest = record.manifestDigest;
        } else {
          delete record.settings.trustedDigest;
        }
      } else {
        record.settings.enabled = item.enabled;
        if (item.trustedDigest === undefined) {
          delete record.settings.trustedDigest;
        } else {
          record.settings.trustedDigest = item.trustedDigest;
        }
      }
      refreshSetting(record);
    }
  }
}

function refreshSetting(record: CapabilityRecord): void {
  record.setting = !record.settings.enabled
    ? "disabled"
    : record.settings.trustedDigest === record.manifestDigest
      ? "trusted"
      : "enabled";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestManifest(manifest: CapabilityManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
