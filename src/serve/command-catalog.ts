export interface RemoteSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  remote: boolean;
}

const builtin: RemoteSlashCommand[] = [
  { name: "settings", description: "Open settings menu", remote: false },
  { name: "model", description: "Select an existing Host model", argumentHint: "<provider/model>", remote: true },
  { name: "scoped-models", description: "Enable or disable models for cycling", remote: false },
  { name: "export", description: "Export the current session", argumentHint: "<path>", remote: false },
  { name: "import", description: "Import and resume a Pi session from JSONL", remote: false },
  { name: "share", description: "Share session as a secret gist", remote: false },
  { name: "copy", description: "Copy last agent message on the PC", remote: false },
  { name: "name", description: "Set session display name", remote: false },
  { name: "session", description: "Show session information", remote: true },
  { name: "changelog", description: "Show changelog", remote: true },
  { name: "hotkeys", description: "Show PC keyboard shortcuts", remote: false },
  { name: "fork", description: "Fork from a previous user message", remote: false },
  { name: "clone", description: "Duplicate the current session", remote: false },
  { name: "tree", description: "Navigate the session tree", remote: false },
  { name: "trust", description: "Authorize a workspace on the PC", remote: false },
  { name: "login", description: "Configure provider authentication on the PC", remote: false },
  { name: "logout", description: "Remove provider authentication on the PC", remote: false },
  { name: "new", description: "Start a new session", remote: true },
  { name: "compact", description: "Compact session context", remote: false },
  { name: "resume", description: "Resume another session", remote: true },
  { name: "reload", description: "Reload PC extensions and configuration", remote: false },
  { name: "quit", description: "Quit the PC TUI", remote: false },
];

const picode: RemoteSlashCommand[] = [
  { name: "pico-help", description: "Browse the categorized Picode command directory", argumentHint: "[all|category|command|query]", remote: false },
  { name: "pico-webagent", description: "Configure the optional Google Search Subagent", argumentHint: "[on|off|config|status|doctor|test]", remote: false },
  { name: "server", description: "Start Picode Remote Serve Mode from this TUI", remote: false },
  { name: "workspace", description: "Authorize and switch PC workspace", argumentHint: "<absolute-directory>", remote: false },
  { name: "slice", description: "Seal a Task Capsule and continue fresh", argumentHint: "<intent>", remote: false },
  { name: "slice-defer", description: "Defer the current hard Slice boundary once", remote: false },
  { name: "harness", description: "Show or switch simple/standard/tdd", argumentHint: "[simple|standard|tdd]", remote: true },
  { name: "harness-prompt", description: "Show or switch prompt guidance", argumentHint: "[none|lean|full]", remote: false },
  { name: "thinking", description: "Show or switch model thinking strength", argumentHint: "[off|minimal|low|medium|high|xhigh]", remote: true },
  { name: "permissions", description: "Show Host permission policy", argumentHint: "[readonly|auto|full]", remote: true },
  { name: "plan", description: "Run the Picode planning workflow", argumentHint: "<goal>", remote: false },
  { name: "reinstall", description: "Install recommended PC components", remote: false },
  { name: "pico-account", description: "List or switch Picode Vault accounts", argumentHint: "[list|use <account-id>]", remote: true },
  { name: "pico-import", description: "Open the PC-only Picode import center", remote: false },
  { name: "pico-login", description: "Log in to the PC-only Picode Account Vault", argumentHint: "<provider>", remote: false },
  { name: "pico-logout", description: "Log out a PC-only Picode Vault account", argumentHint: "[account-id]", remote: false },
  { name: "subagent-model", description: "Select an existing subagent model", argumentHint: "[provider/model]", remote: false },
  { name: "task", description: "Inspect or wait for a Host task", argumentHint: "<status|wait> <task-id>", remote: true },
  { name: "gate", description: "Inspect task gate status or evidence", argumentHint: "<status|evidence> <task-id>", remote: true },
  { name: "capsule", description: "List or read sealed task Capsules", argumentHint: "<list|read> <task-id> [capsule-id]", remote: true },
  { name: "subagent", description: "Inspect a subagent", argumentHint: "status [run-id]", remote: true },
  { name: "worktree", description: "Inspect Host worktree ownership", argumentHint: "status", remote: true },
  { name: "capability", description: "Inspect configured capability state", argumentHint: "status", remote: true },
  { name: "tools", description: "Inspect readiness or search Host tools", argumentHint: "<doctor|search> [query]", remote: true },
  { name: "doctor", description: "Run Host diagnostics", remote: true },
];

export const REMOTE_SLASH_COMMANDS: readonly RemoteSlashCommand[] = [...builtin, ...picode]
  .sort((left, right) => left.name.localeCompare(right.name));

/** Defense in depth for command.execute: Android may only reach accepted Control subjects. */
export function isRemoteControlCommand(argv: readonly string[]): boolean {
  const [subject, action] = argv.filter((value) => !value.startsWith("--"));
  // command.execute is deliberately read-only. Mutations use dedicated RPC
  // methods whose Host transport enforces the Chat Writer Lease.
  if (subject === "session") return action === "list" || action === "events";
  if (subject === "account") return action === "list";
  if (subject === "worktree") return action === "status";
  if (subject === "capability") return action === "status";
  if (subject === "subagent") return action === "status";
  if (subject === "capsule") return action === "list" || action === "read";
  if (subject === "task") return action === "status" || action === "wait";
  if (subject === "gate") return action === "status" || action === "evidence";
  if (subject === "harness" || subject === "permissions") return action === "get";
  if (subject === "tools") return action === "doctor" || action === "search";
  return subject === "doctor" && (action === undefined || action === "tools");
}
