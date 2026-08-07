import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep, join } from "node:path";

export interface ProjectContextEntry {
  path: string;
  content: string;
  priority: number;
  source: "agents" | "claude" | "cursor" | "grok" | "copilot";
}

const MAX_RULE_BYTES = 256 * 1024;

function safeRead(path: string): string | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > MAX_RULE_BYTES) {
      return undefined;
    }
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function filesIn(path: string, extensions: readonly string[]): string[] {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extensions.some((suffix) => entry.name.endsWith(suffix)))
      .map((entry) => join(path, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function directoryChain(repoRoot: string, cwd: string): string[] {
  const root = resolve(repoRoot);
  const target = resolve(cwd);
  const rel = relative(root, target);
  if (rel === "") return [root];
  if (rel.startsWith("..") || rel.split(sep).includes("..")) return [target];
  const chain = [root];
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    chain.push(current);
  }
  return chain;
}

function candidates(dir: string): Array<{ path: string; source: ProjectContextEntry["source"] }> {
  return [
    { path: join(dir, "AGENTS.md"), source: "agents" },
    { path: join(dir, "CLAUDE.md"), source: "claude" },
    { path: join(dir, ".claude", "CLAUDE.md"), source: "claude" },
    { path: join(dir, ".github", "copilot-instructions.md"), source: "copilot" },
    ...filesIn(join(dir, ".cursor", "rules"), [".md", ".mdc"]).map((path) => ({ path, source: "cursor" as const })),
    ...filesIn(join(dir, ".grok", "rules"), [".md", ".mdc"]).map((path) => ({ path, source: "grok" as const })),
  ];
}

/** Grok-compatible root→cwd discovery. Later/deeper entries have higher priority. */
export function discoverProjectContext(input: {
  repoRoot: string;
  cwd: string;
}): ProjectContextEntry[] {
  const result: ProjectContextEntry[] = [];
  const seen = new Set<string>();
  for (const [depth, dir] of directoryChain(input.repoRoot, input.cwd).entries()) {
    for (const candidate of candidates(dir)) {
      const path = resolve(candidate.path);
      if (seen.has(path)) continue;
      const content = safeRead(path);
      if (content === undefined || content === "") continue;
      seen.add(path);
      result.push({ path, content, priority: depth * 1_000 + result.length, source: candidate.source });
    }
  }
  return result;
}

export function renderProjectContext(entries: readonly ProjectContextEntry[]): string {
  if (entries.length === 0) return "";
  return [
    "<picode_project_rules>",
    "These trusted project rules are ordered from repo root to cwd; deeper files have higher priority when instructions conflict.",
    ...entries.flatMap((entry) => [
      `\n## ${entry.path} [${entry.source}; priority=${entry.priority}]`,
      entry.content,
    ]),
    "</picode_project_rules>",
  ].join("\n");
}
