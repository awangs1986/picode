import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PicodeRuntime } from "./index.ts";
import { ForeignChatImportService } from "./foreign-chat-import.ts";
import {
  ChatImportCatalog,
  type ChatArchiveFilter,
  type ChatCatalogScan,
  type ChatImportCandidate,
  type ChatSort,
} from "./chat-import-catalog.ts";
import { TASK_BINDING_ENTRY_TYPE } from "./slice-session.ts";

interface PendingScan {
  scan: ChatCatalogScan;
  candidates: Map<string, ChatImportCandidate>;
  createdAt: number;
}

const MAX_SCANS = 8;
const SCAN_TTL_MS = 10 * 60 * 1_000;

function persistSession(manager: SessionManager): string {
  const file = manager.getSessionFile();
  if (file === undefined) throw new Error("new imported session has no persistent file");
  writeFileSync(file, `${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  return file;
}

/** Temporary Web Wizard state. All durable facts still flow through Runtime/Store/Pi. */
export class WebChatImportCoordinator {
  private readonly scans = new Map<string, PendingScan>();
  private readonly catalog = new ChatImportCatalog();

  constructor(
    private readonly runtime: PicodeRuntime,
    private readonly sessionsRoot: string,
    private readonly now: () => number = Date.now,
  ) {}

  scan(input: {
    source: string;
    path: string;
    archiveFilter: ChatArchiveFilter;
    sort: ChatSort;
  }): ChatCatalogScan {
    this.expireScans();
    const scan = this.catalog.scan({
      sources: [{ source: input.source, path: input.path }],
      archiveFilter: input.archiveFilter,
      sort: input.sort,
    });
    this.scans.set(scan.scanId, {
      scan,
      candidates: new Map(scan.candidates.map((candidate) => [candidate.id, candidate])),
      createdAt: this.now(),
    });
    while (this.scans.size > MAX_SCANS) this.scans.delete(this.scans.keys().next().value as string);
    return scan;
  }

  async apply(input: {
    scanId: string;
    candidateIds: string[];
    workspaceBindings: Record<string, string>;
    includeReasoning: boolean;
  }): Promise<Array<Record<string, unknown>>> {
    this.expireScans();
    const pending = this.scans.get(input.scanId);
    if (pending === undefined) throw new Error("chat scan expired; scan again");
    const selected = [...new Set(input.candidateIds)].map((id) => pending.candidates.get(id));
    if (selected.length === 0 || selected.some((candidate) => candidate === undefined)) {
      throw new Error("chat selection does not match the scan");
    }
    const imported: Array<Record<string, unknown>> = [];
    const service = new ForeignChatImportService(this.runtime);
    for (const candidate of selected as ChatImportCandidate[]) {
      const requestedWorkspace = input.workspaceBindings[candidate.workspaceGroupId];
      if (requestedWorkspace === undefined || requestedWorkspace.trim() === "") {
        throw new Error(`choose a workspace for ${candidate.originalWorkspace ?? candidate.workspaceGroupId}`);
      }
      const workspace = resolve(requestedWorkspace);
      if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
        throw new Error(`workspace does not exist or is not a directory: ${workspace}`);
      }
      const persisted = await service.persist(candidate.source, candidate.file);
      if (!persisted.ok) throw new Error(persisted.error.message);
      const task = await this.runtime.taskIngress.accept({
        source: `import:${candidate.source}`,
        externalId: persisted.value.importId,
        title: candidate.title,
        harnessTier: "simple",
        workspace,
      });
      if (!task.ok) throw new Error(task.error.message);
      const existing = (await SessionManager.listAll(this.sessionsRoot)).find((session) =>
        resolve(session.cwd) === workspace && SessionManager.open(session.path, this.sessionsRoot).getEntries().some((entry) =>
          entry.type === "custom" && entry.customType === "picode.foreign-import" &&
          (entry.data as { importId?: unknown } | undefined)?.importId === persisted.value.importId
        )
      );
      if (existing !== undefined) {
        imported.push({
          importId: persisted.value.importId,
          candidateId: candidate.id,
          taskId: task.value.taskId,
          sessionId: existing.id,
          sessionFile: existing.path,
          archived: candidate.archived,
          reused: true,
        });
        continue;
      }
      const manager = SessionManager.create(workspace, this.sessionsRoot);
      manager.appendCustomEntry(TASK_BINDING_ENTRY_TYPE, { taskId: task.value.taskId, taskRevision: 1 });
      manager.appendCustomEntry("picode.foreign-import", {
        importId: persisted.value.importId,
        sourceAgent: candidate.source,
        archived: candidate.archived,
        includeReasoning: input.includeReasoning,
        originalWorkspace: candidate.originalWorkspace,
        boundWorkspace: workspace,
      });
      manager.appendMessage({
        role: "custom",
        customType: "picode.foreign-resume",
        content: persisted.value.resumeCapsule,
        display: true,
        details: {
          importId: persisted.value.importId,
          sourceAgent: candidate.source,
          reasoningFolded: true,
        },
        timestamp: Date.now(),
      });
      const sessionFile = persistSession(manager);
      imported.push({
        importId: persisted.value.importId,
        candidateId: candidate.id,
        taskId: task.value.taskId,
        sessionId: manager.getSessionId(),
        sessionFile,
        archived: candidate.archived,
      });
    }
    return imported;
  }

  private expireScans(): void {
    const cutoff = this.now() - SCAN_TTL_MS;
    for (const [id, scan] of this.scans) if (scan.createdAt < cutoff) this.scans.delete(id);
  }
}
