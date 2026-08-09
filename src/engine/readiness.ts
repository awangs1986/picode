import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import type { CapabilityReadiness, ReadinessContext, ReadinessReport, SetupPlan } from "../shared/types.ts";
interface ProbeDeps { env: NodeJS.ProcessEnv; commandExists(command: string): boolean }
type Probe = CapabilityReadiness & { capabilityId: string };
const report = (capabilityId: string, status: ReadinessReport["status"], summary: string, missing: string[] = [], nextSteps: string[] = []): ReadinessReport => ({ capabilityId, status, summary, missing, nextSteps, inspectedAt: new Date().toISOString() });
const plan = (capabilityId: string, steps: string[]): SetupPlan => ({ capabilityId, steps, requiresApproval: true });

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined || process.platform !== "win32") return direct;
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

export class CapabilityReadinessRegistry {
  constructor(private readonly probes: Probe[]) {}
  static defaults(overrides: Partial<ProbeDeps> = {}): CapabilityReadinessRegistry {
    const env = overrides.env ?? process.env;
    const commandExists = overrides.commandExists ?? ((command: string) => {
      const packageRoot = environmentValue(env, "PICODE_PACKAGE_ROOT");
      const packageBin = packageRoot === undefined
        ? []
        : [join(packageRoot, "node_modules", ".bin")];
      const runtimeBins = [join(homedir(), ".dotnet", "tools"), join(homedir(), ".cargo", "bin")];
      const directories = [
        ...(environmentValue(env, "PATH") ?? "").split(delimiter),
        ...packageBin,
        ...runtimeBins,
      ].filter(Boolean);
      const names = process.platform === "win32"
        ? [command, `${command}.cmd`, `${command}.exe`]
        : [command];
      return directories.some((dir) => names.some((name) => existsSync(join(dir, name))));
    });
    return new CapabilityReadinessRegistry(defaultProbes({ env, commandExists }));
  }
  inspectAll(context: ReadinessContext, signal?: AbortSignal): Promise<ReadinessReport[]> { return Promise.all(this.probes.map((probe) => probe.inspect(context, signal))); }
  async inspect(capabilityId: string, context: ReadinessContext, signal?: AbortSignal): Promise<ReadinessReport> { const probe = this.probes.find((item) => item.capabilityId === capabilityId); return probe === undefined ? report(capabilityId, "Unavailable", "No readiness adapter is registered") : probe.inspect(context, signal); }
}

/** Turn-boundary schema filter; it never starts or configures a capability. */
export function filterToolNamesForReadiness(toolNames: readonly string[], reports: readonly ReadinessReport[]): string[] {
  const status = new Map(reports.map((item) => [item.capabilityId, item.status]));
  const callable = (id: string): boolean => status.get(id) === "Ready" || status.get(id) === "Degraded";
  return toolNames.filter((name) => {
    if (name === "git") return callable("git");
    if (/^(?:mcp|mcp_)/i.test(name)) return callable("mcp");
    if (/^(?:web_?search|search_?web)$/i.test(name)) return callable("web.search");
    if (/^(?:web_?fetch|fetch_?url)$/i.test(name)) return callable("web.fetch");
    return true;
  });
}

function defaultProbes(deps: ProbeDeps): Probe[] {
  const staticProbe = (capabilityId: string, value: ReadinessReport, steps: string[]): Probe => ({ capabilityId, inspect: async () => value, prepare: async () => plan(capabilityId, steps) });
  return [
    { capabilityId: "git", inspect: async (ctx) => deps.commandExists("git") ? (existsSync(join(ctx.cwd, ".git")) ? report("git", "Ready", "Git executable and repository are available") : report("git", "NeedsSetup", "Directory is not a Git repository", ["repository"], ["Initialize or select a Git repository"])) : report("git", "Unavailable", "Git executable was not found", ["git"]), prepare: async () => plan("git", ["Install Git", "Open a Git repository"]) },
    { capabilityId: "pi-lens", inspect: async (ctx) => {
      if (ctx.harnessTier !== "tdd") {
        return report("pi-lens", "NeedsSetup", "pi-lens is intentionally inactive outside the tdd harness", ["tdd-harness"], ["Switch this session to /harness tdd"]);
      }
      const typescriptProject = existsSync(join(ctx.cwd, "tsconfig.json")) || existsSync(join(ctx.cwd, "package.json"));
      const rustProject = existsSync(join(ctx.cwd, "Cargo.toml"));
      const projectEntries = safeDirectoryEntries(ctx.cwd);
      const csharpProject = projectEntries.some((name) => /\.(?:csproj|sln|slnx)$/i.test(name));
      if (typescriptProject && deps.commandExists("typescript-language-server")) {
        return report("pi-lens", "Ready", "TypeScript code intelligence and language server are available");
      }
      if (rustProject && deps.commandExists("rust-analyzer")) {
        return report("pi-lens", "Ready", "Rust code intelligence and language server are available");
      }
      if (csharpProject && deps.commandExists("csharp-ls")) {
        return report("pi-lens", "Ready", "C# code intelligence and csharp-ls are available");
      }
      const missing = typescriptProject
        ? ["typescript-language-server"]
        : rustProject
          ? ["rust-analyzer"]
          : csharpProject ? ["csharp-ls"] : ["supported-project", "language-server"];
      return report(
        "pi-lens",
        "Degraded",
        "AST/index features are available; no matching project language server was found",
        missing,
        ["Install the language server matching this project"],
      );
    }, prepare: async () => plan("pi-lens", ["Switch to the tdd harness", "Choose and install a project language server"]) },
    { capabilityId: "mcp", inspect: async (ctx) => {
      const candidates = [
        join(deps.env.PI_CODING_AGENT_DIR ?? join(deps.env.PICODE_DIR ?? "", "agent"), "mcp.json"),
        join(ctx.cwd, ".mcp.json"), join(ctx.cwd, ".pi", "mcp.json"),
        join(homedir(), ".config", "mcp", "mcp.json"), join(homedir(), ".agents", "mcp.json"),
      ].filter((path, index, all) => path !== "" && all.indexOf(path) === index && existsSync(path));
      if (candidates.length === 0) return report("mcp", "NeedsSetup", "No MCP server configuration was found", ["server"], ["Run /mcp setup"]);
      let invalid = false;
      for (const config of candidates) {
        try { const value = JSON.parse(readFileSync(config, "utf8")) as { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown>; "mcp-servers"?: Record<string, unknown> }; const servers = value.mcpServers ?? value["mcp-servers"] ?? value.servers; if (servers && Object.keys(servers).length > 0) return report("mcp", "Ready", `MCP servers are configured in ${config}`); }
        catch { invalid = true; }
      }
      return invalid ? report("mcp", "NeedsSetup", "MCP configuration is invalid", ["valid-config"], ["Repair MCP configuration"]) : report("mcp", "NeedsSetup", "MCP configuration has no servers", ["server"], ["Run /mcp setup"]);
    }, prepare: async () => plan("mcp", ["Run /mcp setup", "Review and approve the server configuration"]) },
    staticProbe("web.fetch", report("web.fetch", "Ready", "Direct URL fetch is available without a search provider"), []),
    { capabilityId: "web.search", inspect: async () => Object.keys(deps.env).some((key) => /(?:BRAVE|TAVILY|SERPER|OPENAI)_API_KEY/.test(key) && Boolean(deps.env[key])) ? report("web.search", "Ready", "A configured search provider is available") : report("web.search", "Ready", "pi-web-access provides a zero-config Exa search fallback"), prepare: async () => plan("web.search", ["Optionally choose and configure a preferred provider"]) },
  ];
}

function safeDirectoryEntries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
