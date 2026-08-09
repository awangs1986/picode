import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessTier } from "../shared/types.ts";
import { TIER_POLICIES } from "./harness.ts";

export type PromptLevel = "none" | "lean" | "full";
export const PROMPT_LEVEL_ENTRY_TYPE = "picode.prompt-level";

export function effectivePromptLevel(
  harnessTier: HarnessTier,
  override: PromptLevel | undefined,
): PromptLevel {
  return override ?? TIER_POLICIES[harnessTier].promptInjection;
}

export function restorePromptOverride(entries: readonly unknown[]): PromptLevel | undefined {
  let level: PromptLevel | undefined;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (row.type !== "custom" || row.customType !== PROMPT_LEVEL_ENTRY_TYPE) continue;
    if (typeof row.data !== "object" || row.data === null) continue;
    const candidate = (row.data as { level?: unknown }).level;
    if (candidate === "harness-default") {
      level = undefined;
      continue;
    }
    if (candidate === "none" || candidate === "lean" || candidate === "full") level = candidate;
  }
  return level;
}

export function sessionPromptInjection(
  harnessTier: HarnessTier,
  override: PromptLevel | undefined,
  promptsDir?: string,
): string | undefined {
  const level = effectivePromptLevel(harnessTier, override);
  const injection = systemPromptInjection(level, promptsDir);
  if (injection === undefined || override === undefined) return injection;
  return `${injection}\n\n<picode_prompt_scope>\n` +
    `Active harness: ${harnessTier}. Prompt guidance level: ${level} (manual session override). ` +
    "This changes guidance only; tools, permissions, sandbox, watchdog, and verification remain controlled by the active harness. " +
    "Use only tools and gates actually available in this session.\n" +
    "</picode_prompt_scope>";
}

/**
 * Harness 的三档默认提示词（Q19 / V3 §6）：
 * - simple → none：零注入，保持 Pi 原生系统提示词。
 * - standard → lean：注入薄行为核 prompts/harness-core.md。
 * - tdd → full：注入完整 Developer-TDD 行为核 prompts/tdd-core.md。
 *   作者移植时只改文件不改代码；
 *   工具名经占位符重映射（{{TOOL_*}}），语义不兼容部分在文件内适配。
 *
 * /system prompt 可在当前会话覆盖 none/lean/full，但只改变行为引导，不改变
 * Harness 的工具、权限、沙箱或 Gate。切换 Harness 会清除覆盖并恢复新档位默认值。
 * 任一有效切换都开启新 Cache Epoch，随后保持前缀稳定。
 */

/** Pi 原生工具名重映射表；移植提示词用占位符，避免写死外来工具名 */
export const TOOL_PLACEHOLDERS: Record<string, string> = {
  "{{TOOL_READ}}": "read",
  "{{TOOL_WRITE}}": "write",
  "{{TOOL_EDIT}}": "edit",
  "{{TOOL_BASH}}": "bash",
  "{{TOOL_GREP}}": "grep",
  "{{TOOL_GLOB}}": "find",
  "{{TOOL_LIST}}": "ls",
  "{{TOOL_SEARCH_TOOLS}}": "search_tools",
};

/** harness-core.md 缺失时的内置最小骨架。 */
export const BUILTIN_LEAN_PROMPT = `# Picode Harness Core (Lean)

You are assisting with software engineering in Picode's **standard harness** tier.
Pi's base agent prompt still applies; the rules below are Picode's thin behavioral layer.

## Harness
- Pi-native file and search tools are already available and do not require {{TOOL_SEARCH_TOOLS}}. Use them instead of {{TOOL_BASH}} for file reads, directory listing, filename search, and text search.
- Use {{TOOL_LIST}} for directories and {{TOOL_READ}} only for files. After an EISDIR result, switch to {{TOOL_LIST}} instead of retrying {{TOOL_READ}}.
- On Windows, {{TOOL_BASH}} executes PowerShell syntax through the sandbox provider.
- Discover optional capabilities with {{TOOL_SEARCH_TOOLS}}; request activation and wait for a grant.
- If a tool call is denied, adjust rather than repeating the same call verbatim.

## Care and honesty
- Confirm before hard-to-reverse, shared, or outward-facing actions unless the user authorized that scope.
- Report what was run, what passed or failed, and what remains unverified.
`;

/** tdd-core.md 缺失时的内置最小骨架。 */
export const BUILTIN_TDD_PROMPT = `# Picode TDD Harness

You are operating under Picode's developer-TDD verification profile.

## Discipline
- Before implementing, write or update a failing test that captures the requirement (recorded RED).
- Only implement after the failing test is recorded. Make it pass, then refactor.
- Run the project's gates before claiming completion. Never claim tests pass without running them.
- Fix budget: at most ${2} fix rounds after a failing gate; then stop and report for a decision.

## Tools
- Use {{TOOL_SEARCH_TOOLS}} to discover additional capabilities; request activation, never assume.
- Prefer {{TOOL_GREP}}/{{TOOL_GLOB}} for search, {{TOOL_LIST}} for directories, and {{TOOL_READ}} before {{TOOL_EDIT}}.
- On Windows, {{TOOL_BASH}} executes PowerShell syntax through the sandbox provider.

## Reporting
- State outcomes faithfully: failing tests, skipped steps, flaky gates.
- Completion claims must reference gate evidence; the harness issues the final completion label, not you.
`;

export function applyToolPlaceholders(text: string): string {
  let out = text;
  for (const [placeholder, tool] of Object.entries(TOOL_PLACEHOLDERS)) {
    out = out.split(placeholder).join(tool);
  }
  return out;
}

/** Author provenance belongs in source control, not in the model prefix. */
export function stripAuthorComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").trimEnd();
}

const INJECTION_FILE = {
  lean: "harness-core.md",
  full: "tdd-core.md",
} as const;

const INJECTION_BUILTIN = {
  lean: BUILTIN_LEAN_PROMPT,
  full: BUILTIN_TDD_PROMPT,
} as const;

/**
 * 返回该档位应注入的系统提示词增量；undefined = 零注入。
 * @param promptsDir 包内 prompts/ 目录（组合根从包根解析）
 */
export function systemPromptInjection(
  selection: HarnessTier | PromptLevel,
  promptsDir?: string,
): string | undefined {
  const mode: PromptLevel = selection === "simple" || selection === "standard" || selection === "tdd"
    ? TIER_POLICIES[selection].promptInjection
    : selection;
  if (mode === "none") return undefined;
  let raw: string = INJECTION_BUILTIN[mode];
  const resolvedPromptsDir = promptsDir ?? (
    process.env.PICODE_PACKAGE_ROOT === undefined
      ? fileURLToPath(new URL("../../prompts", import.meta.url))
      : join(process.env.PICODE_PACKAGE_ROOT, "prompts")
  );
  const file = join(resolvedPromptsDir, INJECTION_FILE[mode]);
  if (existsSync(file)) raw = readFileSync(file, "utf8");
  const rendered = applyToolPlaceholders(stripAuthorComments(raw));
  if (rendered.includes("{{TOOL_")) {
    throw new Error(`unresolved tool placeholder in ${INJECTION_FILE[mode]}`);
  }
  return rendered;
}
