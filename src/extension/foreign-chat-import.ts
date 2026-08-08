import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { renderForeignResumeCapsule } from "../devloop/index.ts";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import { adapterFor, buildCompatReport, renderCompatReport } from "../store/index.ts";
import type { CompatReport } from "../store/index.ts";
import type { PicodeRuntime } from "./index.ts";
import { TASK_BINDING_ENTRY_TYPE } from "./slice-session.ts";

const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

export interface ForeignChatPreview {
  importId: string;
  title: string;
  lastMessage: string;
  lastTimestamp?: string;
  bytes: number;
  archived: false;
  report: CompatReport;
  reportText: string;
  resumeCapsule: string;
}

export class ForeignChatImportService {
  constructor(private readonly runtime: PicodeRuntime) {}

  async preview(sourceAgent: string, file: string): Promise<Result<ForeignChatPreview>> {
    const adapter = adapterFor(sourceAgent);
    if (adapter === undefined) {
      return err("import/source-unsupported", `unsupported source agent: ${sourceAgent}`);
    }
    let raw: string;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) {
        return err("import/source-too-large", `source must be a file no larger than ${MAX_IMPORT_BYTES} bytes`);
      }
      raw = readFileSync(file, "utf8");
    } catch (cause) {
      return err("import/source-unreadable", `cannot read import source: ${file}`, cause);
    }
    const parsed = adapter.parse(raw);
    if (!parsed.ok) return parsed;
    const compiled = this.runtime.store.compileImport(parsed.value);
    const report = buildCompatReport(parsed.value, compiled);
    const dialog = compiled.events
      .filter((event): event is Extract<typeof event, { kind: "message" }> => event.kind === "message")
      .slice(-12)
      .map((event) => `${event.role}: ${event.text}`);
    const lastUser = [...compiled.events].reverse().find(
      (event) => event.kind === "message" && event.role === "user" && event.text.trim() !== "",
    );
    const lastMessage = [...compiled.events].reverse().find((event) => event.kind === "message");
    const lastTimestamp = [...parsed.value.events].reverse().find((event) => event.timestamp !== undefined)?.timestamp;
    const losses = [
      ...(report.counts.adaptedLossy > 0 ? [`${report.counts.adaptedLossy} lossy tool mappings`] : []),
      ...(report.counts.unsupported > 0 ? [`${report.counts.unsupported} unsupported tool mappings`] : []),
      ...(report.danglingCalls > 0 ? [`${report.danglingCalls} dangling tool calls`] : []),
      ...(report.orphanResults > 0 ? [`${report.orphanResults} orphan tool results`] : []),
    ];
    const resumeCapsule = renderForeignResumeCapsule({
      sourceAgent,
      goal: lastUser?.kind === "message" ? lastUser.text : `Continue imported ${sourceAgent} session`,
      recentDialog: dialog,
      completed: [],
      pending: [],
      filesChanged: [],
      losses,
      workspaceState: "Bound to the current local workspace; imported claims remain unverified.",
    });
    return ok({
      importId: createHash("sha256").update(`${sourceAgent}\0${raw}`).digest("hex").slice(0, 24),
      title: parsed.value.sessionTitle ?? (lastUser?.kind === "message" ? lastUser.text.slice(0, 120) : `Imported ${sourceAgent} chat`),
      lastMessage: lastMessage?.kind === "message" ? lastMessage.text.slice(0, 280) : "",
      ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
      bytes: Buffer.byteLength(raw, "utf8"),
      archived: false,
      report,
      reportText: renderCompatReport(report),
      resumeCapsule,
    });
  }

  async persist(sourceAgent: string, file: string): Promise<Result<ForeignChatPreview>> {
    const preview = await this.preview(sourceAgent, file);
    if (!preview.ok) return preview;
    const adapter = adapterFor(sourceAgent);
    if (adapter === undefined) return err("import/source-unsupported", `unsupported source agent: ${sourceAgent}`);
    const raw = readFileSync(file, "utf8");
    const parsed = adapter.parse(raw);
    if (!parsed.ok) return parsed;
    const compiled = this.runtime.store.compileImport(parsed.value);
    const persisted = await this.runtime.store.persistImport(sourceAgent, raw, parsed.value, compiled);
    if (!persisted.ok) return persisted;
    return ok(preview.value);
  }

  async continue(
    sourceAgent: string,
    file: string,
    ctx: ExtensionCommandContext,
  ): Promise<Result<{ importId: string; taskId: string }>> {
    const preview = await this.preview(sourceAgent, file);
    if (!preview.ok) return preview;
    const confirmed = await ctx.ui.confirm(
      "Bind imported chat",
      `Continue this ${sourceAgent} history in the current workspace?\n${ctx.cwd}\n\n${preview.value.reportText}`,
    );
    if (!confirmed) return err("import/cancelled", "workspace binding cancelled");
    const persisted = await this.persist(sourceAgent, file);
    if (!persisted.ok) return persisted;
    const task = await this.runtime.taskIngress.accept({
      source: `import:${sourceAgent}`,
      externalId: preview.value.importId,
      title: `Continue imported ${sourceAgent} session`,
      harnessTier: this.runtime.harness.current(),
      workspace: ctx.cwd,
    });
    if (!task.ok) return task;
    const result = await ctx.newSession({
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(TASK_BINDING_ENTRY_TYPE, {
          taskId: task.value.taskId,
          taskRevision: 1,
        });
        sessionManager.appendCustomEntry("picode.foreign-import", {
          importId: preview.value.importId,
          sourceAgent,
        });
      },
      withSession: async (replacementCtx) => {
        await replacementCtx.sendMessage({
          customType: "picode.foreign-resume",
          content: preview.value.resumeCapsule,
          display: true,
          details: { importId: preview.value.importId, sourceAgent },
        }, { triggerTurn: false });
        replacementCtx.ui.notify("Imported history is ready. Enter continue to start work.", "info");
      },
    });
    if (result.cancelled) return err("import/session-cancelled", "new Pi session creation cancelled");
    return ok({ importId: preview.value.importId, taskId: task.value.taskId });
  }
}
