import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { adapterFor } from "../store/import-adapters.ts";

const MAX_FILES = 5_000;
const MAX_DEPTH = 12;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;

export type ChatArchiveFilter = "active" | "archived" | "all";
export type ChatSort = "updated-desc" | "updated-asc" | "size-desc" | "size-asc";

export interface ChatImportCandidate {
  id: string;
  source: string;
  file: string;
  title: string;
  lastMessageSnippet: string;
  originalWorkspace?: string;
  workspaceGroupId: string;
  archived: boolean;
  createdAt?: string;
  updatedAt: string;
  fileSizeBytes: number;
  contentDigest: string;
}

export interface WorkspaceImportGroup {
  id: string;
  source: string;
  originalWorkspace?: string;
  candidateCount: number;
}

export interface ChatCatalogScan {
  scanId: string;
  candidates: ChatImportCandidate[];
  workspaceGroups: WorkspaceImportGroup[];
  duplicatesSkipped: number;
  warnings: string[];
}

export interface ChatCatalogScanInput {
  sources: Array<{ source: string; path: string }>;
  archiveFilter?: ChatArchiveFilter;
  sort?: ChatSort;
}

function normalizeWorkspace(value: string): string | undefined {
  let normalized = value.trim().replaceAll("\\", "/");
  if (/^\/[A-Za-z]:\//.test(normalized)) normalized = normalized.slice(1);
  if (normalized.startsWith("file://")) {
    try { normalized = decodeURIComponent(new URL(normalized).pathname); }
    catch { return undefined; }
    if (/^\/[A-Za-z]:\//.test(normalized)) normalized = normalized.slice(1);
  }
  normalized = normalized.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized === "" ? undefined : normalized;
}

function findWorkspace(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWorkspace(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const row = value as Record<string, unknown>;
  for (const key of ["cwd", "workspace", "workspacePath", "projectPath", "rootPath"]) {
    if (typeof row[key] === "string") {
      const found = normalizeWorkspace(row[key]);
      if (found !== undefined) return found;
    }
  }
  for (const nested of Object.values(row)) {
    const found = findWorkspace(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function sampledFile(file: string): { text: string; digest: string; bytes: number; updatedAt: string } {
  const stat = statSync(file);
  const headSize = Math.min(stat.size, HEAD_BYTES);
  const tailSize = Math.min(Math.max(0, stat.size - headSize), TAIL_BYTES);
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(headSize);
    if (headSize > 0) readSync(fd, head, 0, headSize, 0);
    const tail = Buffer.alloc(tailSize);
    if (tailSize > 0) readSync(fd, tail, 0, tailSize, stat.size - tailSize);
    const sampled = tailSize === 0 ? head : Buffer.concat([head, Buffer.from("\n"), tail]);
    return {
      text: sampled.toString("utf8"),
      digest: createHash("sha256")
        .update(String(stat.size)).update("\0").update(sampled)
        .digest("hex"),
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } finally {
    closeSync(fd);
  }
}

function filesBelow(root: string): string[] {
  const absolute = resolve(root);
  if (!existsSync(absolute)) throw new Error(`import path not found: ${root}`);
  if (statSync(absolute).isFile()) return [absolute];
  const files: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: absolute, depth: 0 }];
  while (pending.length > 0 && files.length < MAX_FILES) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const child = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < MAX_DEPTH) pending.push({ path: child, depth: current.depth + 1 });
      else if (entry.isFile() && /\.jsonl?$/i.test(entry.name)) files.push(child);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files.sort();
}

function workspaceFromSample(text: string): string | undefined {
  for (const line of text.split(/\r?\n/).slice(0, 500)) {
    if (line.trim() === "") continue;
    try {
      const found = findWorkspace(JSON.parse(line));
      if (found !== undefined) return found;
    } catch {
      // A sampled edge can contain a partial JSON line; metadata scan remains best-effort.
    }
  }
  return undefined;
}

function conversationText(value: string | undefined): string | undefined {
  const clean = value?.replace(/\s+/g, " ").trim();
  if (clean === undefined || clean === "") return undefined;
  if (/^<environment_context>/i.test(clean)) return undefined;
  if (/^the following is the .*agent history/i.test(clean)) return undefined;
  return clean;
}

function groupId(source: string, workspace?: string): string {
  return createHash("sha256")
    .update(`${source}\0${workspace?.toLocaleLowerCase() ?? "<unassigned>"}`)
    .digest("hex").slice(0, 20);
}

function compare(sort: ChatSort): (left: ChatImportCandidate, right: ChatImportCandidate) => number {
  if (sort === "updated-asc") return (a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
  if (sort === "size-desc") return (a, b) => b.fileSizeBytes - a.fileSizeBytes || a.id.localeCompare(b.id);
  if (sort === "size-asc") return (a, b) => a.fileSizeBytes - b.fileSizeBytes || a.id.localeCompare(b.id);
  return (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** V2-compatible metadata scanner. It never parses a whole large transcript. */
export class ChatImportCatalog {
  scan(input: ChatCatalogScanInput): ChatCatalogScan {
    const filter = input.archiveFilter ?? "active";
    const sort = input.sort ?? "updated-desc";
    const candidates: ChatImportCandidate[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    let duplicatesSkipped = 0;
    for (const sourceInput of input.sources) {
      const source = sourceInput.source === "claude" ? "claude-code" : sourceInput.source;
      const adapter = adapterFor(source);
      if (adapter === undefined) {
        warnings.push(`unsupported source: ${sourceInput.source}`);
        continue;
      }
      for (const file of filesBelow(sourceInput.path)) {
        try {
          const sample = sampledFile(file);
          const archived = /(^|[\\/])(archived_sessions?|archive)([\\/]|$)/i.test(file);
          if ((filter === "active" && archived) || (filter === "archived" && !archived)) continue;
          const dedupeKey = `${source}\0${sample.digest}`;
          if (seen.has(dedupeKey)) {
            duplicatesSkipped += 1;
            continue;
          }
          const parsed = adapter.parse(sample.text);
          if (!parsed.ok) {
            warnings.push(`${file}: ${parsed.error.message}`);
            continue;
          }
          const dialog = parsed.value.events.filter((event) =>
            event.kind === "user" || event.kind === "assistant"
          ).map((event) => ({ ...event, text: conversationText(event.text) }))
            .filter((event) => event.text !== undefined);
          const firstUser = dialog.find((event) => event.kind === "user");
          const lastDialog = dialog.at(-1);
          if (firstUser?.text === undefined && lastDialog?.text === undefined) continue;
          const workspace = workspaceFromSample(sample.text);
          const workspaceGroupId = groupId(source, workspace);
          seen.add(dedupeKey);
          candidates.push({
            id: createHash("sha256").update(`${source}\0${sample.digest}`).digest("hex").slice(0, 24),
            source,
            file: resolve(file),
            title: (parsed.value.sessionTitle ?? firstUser?.text ?? basename(file)).slice(0, 160),
            lastMessageSnippet: (lastDialog?.text ?? "").slice(0, 400),
            ...(workspace === undefined ? {} : { originalWorkspace: workspace }),
            workspaceGroupId,
            archived,
            updatedAt: lastDialog?.timestamp ?? sample.updatedAt,
            fileSizeBytes: sample.bytes,
            contentDigest: sample.digest,
          });
        } catch (cause) {
          warnings.push(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
    candidates.sort(compare(sort));
    const grouped = new Map<string, WorkspaceImportGroup>();
    for (const item of candidates) {
      const current = grouped.get(item.workspaceGroupId);
      if (current !== undefined) current.candidateCount += 1;
      else grouped.set(item.workspaceGroupId, {
        id: item.workspaceGroupId,
        source: item.source,
        ...(item.originalWorkspace === undefined ? {} : { originalWorkspace: item.originalWorkspace }),
        candidateCount: 1,
      });
    }
    return {
      scanId: randomUUID(),
      candidates,
      workspaceGroups: [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id)),
      duplicatesSkipped,
      warnings,
    };
  }
}
