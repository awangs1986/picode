import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../shared/fs.ts";
import { dataPaths } from "../shared/paths.ts";
import type { CacheMeterSnapshot, PrefixSignals } from "../shared/types.ts";

/**
 * 缓存方案 v2 的信号计算与指标落盘（PICODE-V3-DESIGN.md §3.3，R3 校正版）。
 * 归因信号六项；落盘非权威（metrics/cache-YYYYMM.jsonl，可分析可丢弃）。
 */

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface PrefixInputs {
  systemPrompt: string;
  /** 当前请求实际携带的工具 schema 的稳定序列化 */
  toolSchemaJson: string;
  /** 保留历史锚点：最早保留消息的稳定序列化（识别 compact/重排） */
  retainedHistoryHead: string;
  provider: string;
  model: string;
  baseUrl?: string;
  promptCacheKey?: string;
  cacheRetention?: string;
}

export function computePrefixSignals(inputs: PrefixInputs): PrefixSignals {
  const signals: PrefixSignals = {
    systemDigest: sha256(inputs.systemPrompt),
    toolSchemaDigest: sha256(inputs.toolSchemaJson),
    retainedHistoryAnchorDigest: sha256(inputs.retainedHistoryHead),
    provider: inputs.provider,
    model: inputs.model,
  };
  if (inputs.baseUrl !== undefined) signals.baseUrl = inputs.baseUrl;
  if (inputs.promptCacheKey !== undefined) signals.promptCacheKeyHash = sha256(inputs.promptCacheKey);
  if (inputs.cacheRetention !== undefined) signals.cacheRetention = inputs.cacheRetention;
  return signals;
}

export interface CacheMetricRecord {
  ts: string;
  sessionId: string;
  snapshot: CacheMeterSnapshot;
  signals?: PrefixSignals;
}

export async function appendCacheMetric(record: CacheMetricRecord): Promise<void> {
  const dir = dataPaths.metrics();
  mkdirSync(dir, { recursive: true });
  const yyyymm = record.ts.slice(0, 7).replace("-", "");
  const file = join(dir, `cache-${yyyymm}.jsonl`);
  await withFileLock(`${file}.lock`, () => {
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  });
}
