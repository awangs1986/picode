export type SubagentProfile = "scout" | "reviewer" | "tester" | "task";

export type SubagentTaskInput = {
  name?: string;
  agent?: SubagentProfile;
  class?: string;
  task: string;
  scope?: string[];
  tools?: string[];
  method?: string;
  stopConditions?: string[];
  expectedResult?: string;
  effort?: "lo" | "med" | "hi";
  isolated?: boolean;
  usesSecret?: boolean;
  destructive?: boolean;
  ambiguous?: boolean;
};

export type TaskToolInput = {
  context?: string;
  tasks?: SubagentTaskInput[];
  task?: string;
  name?: string;
  agent?: SubagentProfile;
  class?: string;
  scope?: string[];
  tools?: string[];
  method?: string;
  stopConditions?: string[];
  expectedResult?: string;
  effort?: "lo" | "med" | "hi";
  isolated?: boolean;
};

export type NormalizedDelegation = {
  name: string;
  agent: SubagentProfile;
  effort?: "lo" | "med" | "hi";
  isolated: boolean;
  work: {
    class: string;
    envelope: {
      goal: string;
      scope: string[];
      method: string;
      tools: string[];
      permissions: string[];
      context: string[];
      stopConditions: string[];
      expectedResult: string;
    };
    requiresWrite: boolean;
    usesSecret: boolean;
    destructive: boolean;
    ambiguous: boolean;
    independentlyVerifiable: boolean;
    contextBytes: number;
  };
};

const PROFILES: Record<
  SubagentProfile,
  { className: string; tools: string[]; method: string; expectedResult: string }
> = {
  scout: {
    className: "repository-search",
    tools: ["search", "read"],
    method: "bounded repository or documentation search",
    expectedResult: "concise findings with file paths, line references, and uncertainty",
  },
  reviewer: {
    className: "code-review",
    tools: ["search", "read", "execute"],
    method: "independent code review with focused read-only verification",
    expectedResult: "prioritized findings with evidence and reproduction or verification steps",
  },
  tester: {
    className: "test-execution",
    tools: ["search", "read", "execute"],
    method: "run bounded tests and diagnose failures without editing production files",
    expectedResult: "test results, failures, relevant logs, and recommended next action",
  },
  task: {
    className: "implementation",
    tools: ["search", "read", "execute", "edit", "write"],
    method: "implement the bounded assignment and verify only the assigned scope",
    expectedResult: "changed files, verification evidence, remaining risks, and blockers",
  },
};

const ALLOWED_TOOLS = new Set(["search", "read", "execute", "edit", "write"]);

export function normalizeTaskToolInput(input: TaskToolInput): NormalizedDelegation[] {
  const items: SubagentTaskInput[] = Array.isArray(input.tasks)
    ? input.tasks
    : input.task
      ? [
          {
            name: input.name,
            agent: input.agent,
            class: input.class,
            task: input.task,
            scope: input.scope,
            tools: input.tools,
            method: input.method,
            stopConditions: input.stopConditions,
            expectedResult: input.expectedResult,
            effort: input.effort,
            isolated: input.isolated,
          },
        ]
      : [];
  if (items.length === 0 || items.length > 16) throw new Error("task requires 1 to 16 assignments");
  const names = new Set<string>();
  return items.map((item, index) => {
    if (!item.task?.trim()) throw new Error(`Subagent assignment ${index + 1} has no task`);
    const agent = item.agent || "task";
    const profile = PROFILES[agent];
    if (!profile) throw new Error(`Unknown Subagent profile: ${String(agent)}`);
    const name = item.name?.trim() || `${agent}-${index + 1}`;
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate Subagent name: ${name}`);
    names.add(name.toLowerCase());
    const tools = item.tools?.length ? [...new Set(item.tools)] : [...profile.tools];
    if (tools.some((tool) => !ALLOWED_TOOLS.has(tool))) {
      throw new Error(`Subagent ${name} requested an unsupported tool`);
    }
    const requiresWrite = tools.includes("edit") || tools.includes("write");
    if (item.isolated && requiresWrite) {
      throw new Error(
        `Subagent ${name} requested isolated writes. Create and authorize a Picode Safe Worktree before delegating it.`,
      );
    }
    const context = [
      input.context?.trim(),
      `Subagent profile: ${agent}`,
      `Assignment name: ${name}`,
    ].filter((value): value is string => Boolean(value));
    const envelope = {
      goal: item.task.trim(),
      scope: item.scope?.length ? item.scope : ["current task workspace"],
      method: item.method?.trim() || profile.method,
      tools,
      permissions: requiresWrite ? ["workspace.read", "workspace.write"] : ["workspace.read"],
      context,
      stopConditions: item.stopConditions?.length
        ? item.stopConditions
        : ["assigned result is independently verifiable", "stop and report any scope ambiguity"],
      expectedResult: item.expectedResult?.trim() || profile.expectedResult,
    };
    return {
      name,
      agent,
      effort: item.effort,
      isolated: item.isolated === true,
      work: {
        class: item.class?.trim() || profile.className,
        envelope,
        requiresWrite,
        usesSecret: item.usesSecret === true,
        destructive: item.destructive === true,
        ambiguous: item.ambiguous === true,
        independentlyVerifiable: true,
        contextBytes: Buffer.byteLength(JSON.stringify(envelope)),
      },
    };
  });
}
