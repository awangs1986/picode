import type { ToolOutputContentBlock } from "./tool-output-retention.ts";

export interface SemanticToolResultInput {
  toolName: string;
  input: Record<string, unknown>;
  content: ToolOutputContentBlock[];
  details?: unknown;
  isError: boolean;
}

export interface SemanticToolResult {
  semantic: boolean;
  content: ToolOutputContentBlock[];
}

type SemanticKind = "command" | "search" | "git" | "web" | "mcp";
const MAX_FIELD_CHARS = 240;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function scalar(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  return text.length <= MAX_FIELD_CHARS ? text : `${text.slice(0, MAX_FIELD_CHARS - 1)}…`;
}

function first(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = scalar(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function classify(toolName: string): SemanticKind | undefined {
  const name = toolName.toLowerCase();
  if (["bash", "run_terminal_command", "shell", "terminal"].includes(name)) return "command";
  if (["grep", "find", "ls", "list_dir", "search_files"].includes(name)) return "search";
  if (["git", "picode_git"].includes(name)) return "git";
  if (name === "mcp" || name.startsWith("mcp_") || name.startsWith("mcp.")) return "mcp";
  if (["web_search", "web_fetch", "search_web", "fetch_url"].includes(name)) return "web";
  return undefined;
}

function truncationFlag(details: Record<string, unknown>): boolean {
  const truncation = record(details.truncation);
  return details.matchLimitReached === true || details.linesTruncated === true ||
    (typeof details.linesTruncated === "number" && details.linesTruncated > 0) ||
    details.resultLimitReached === true || details.entryLimitReached === true ||
    truncation.truncated === true || truncation.outputLines !== undefined ||
    truncation.truncatedLines !== undefined;
}

function semanticFields(input: SemanticToolResultInput, kind: SemanticKind): Array<[string, string | undefined]> {
  const details = record(input.details);
  const common: Array<[string, string | undefined]> = [
    ["kind", kind],
    ["tool", scalar(input.toolName)],
    ["outcome", input.isError ? "error" : "success"],
  ];
  if (kind === "command") {
    return [...common,
      ["command", first(input.input, ["command", "cmd", "script"])],
      ["artifact", first(details, ["fullOutputPath", "path"])],
      ["truncated", truncationFlag(details) ? "true" : undefined],
    ];
  }
  if (kind === "search") {
    return [...common,
      ["query", first(input.input, ["pattern", "query", "glob", "name"])],
      ["scope", first(input.input, ["path", "cwd", "directory", "root"])],
      ["truncated", truncationFlag(details) ? "true" : undefined],
    ];
  }
  if (kind === "git") {
    return [...common,
      ["action", first(input.input, ["action", "command", "operation"])],
      ["repo", first(input.input, ["cwd", "path", "repo"])],
    ];
  }
  if (kind === "web") {
    return [...common,
      ["query", first(input.input, ["query", "q"])],
      ["url", first(input.input, ["url", "uri"])],
      ["results", first(details, ["resultCount", "count"])],
    ];
  }
  return [...common,
    ["server", first(input.input, ["server", "serverName", "provider"])],
    ["operation", first(input.input, ["tool", "toolName", "operation", "action"])],
    ["results", first(details, ["resultCount", "count"])],
  ];
}

/**
 * Add a bounded, machine-readable synopsis to noisy first-party tool results.
 * Original evidence remains present after the header; unknown tools are
 * deliberately untouched so this compiler cannot reinterpret them.
 */
export function renderToolResult(input: SemanticToolResultInput): SemanticToolResult {
  const kind = classify(input.toolName);
  if (kind === undefined) return { semantic: false, content: input.content };
  const header = `[Picode tool evidence: ${semanticFields(input, kind)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ")}]`;
  const firstText = input.content.findIndex((block) => block.type === "text" && typeof block.text === "string");
  if (firstText < 0) return { semantic: true, content: [{ type: "text", text: header }, ...input.content] };
  return {
    semantic: true,
    content: input.content.map((block, index) => index === firstText
      ? { ...block, text: `${header}\n${block.text ?? ""}` }
      : block),
  };
}
