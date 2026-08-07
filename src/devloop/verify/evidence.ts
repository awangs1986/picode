import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PicodeEvent } from "../../shared/events.ts";
import { withFileLock } from "../../shared/fs.ts";
import { dataPaths } from "../../shared/paths.ts";

/**
 * Evidence 落盘（MODULES.md §3.4 双层格式的 Picode 自有事件层）：
 * 统一信封 append 进 evidence/<yyyymm>.jsonl。
 * Subagent 运行证据不转写——存 pi-subagents 生命周期工件 v3 指针。
 *
 * verify/ 是唯一有权签发 Completion Label 的墙（保留条款 ①）；
 * TDD 状态机与 Gate 在 P3 落地，本文件先立 append-only 纪律。
 */
export async function appendEvidence(event: PicodeEvent): Promise<void> {
  const dir = dataPaths.evidence();
  mkdirSync(dir, { recursive: true });
  const yyyymm = event.ts.slice(0, 7).replace("-", "");
  const file = join(dir, `${yyyymm}.jsonl`);
  await withFileLock(`${file}.lock`, () => {
    appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  });
}
