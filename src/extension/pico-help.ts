import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export type HelpLocale = "zh" | "en";
export type HelpCategoryId =
  | "session"
  | "models"
  | "harness"
  | "safety"
  | "tools"
  | "data"
  | "remote"
  | "system"
  | "extensions";

export interface RuntimeSlashCommand {
  name: string;
  description?: string;
  source?: "extension" | "prompt" | "skill";
}

export interface HelpCommand {
  name: string;
  usage: string;
  description: string;
  category: HelpCategoryId;
  owner: "pi" | "picode" | "extension" | "skill";
}

export interface HelpCategory {
  id: HelpCategoryId;
  label: string;
  description: string;
  commands: HelpCommand[];
}

interface LocalizedText {
  zh: string;
  en: string;
}

interface CommandMetadata {
  category: HelpCategoryId;
  description: LocalizedText;
  argumentHint?: string;
}

const CATEGORY_ORDER: readonly HelpCategoryId[] = [
  "session",
  "models",
  "harness",
  "safety",
  "tools",
  "data",
  "remote",
  "system",
  "extensions",
];

const CATEGORY_TEXT: Record<HelpCategoryId, { label: LocalizedText; description: LocalizedText }> = {
  session: {
    label: { zh: "会话与导航", en: "Sessions & navigation" },
    description: { zh: "新建、恢复、分支及控制当前对话", en: "Create, resume, branch, and steer conversations" },
  },
  models: {
    label: { zh: "模型与账号", en: "Models & accounts" },
    description: { zh: "选择模型、思考强度及账号来源", en: "Choose models, thinking levels, and account sources" },
  },
  harness: {
    label: { zh: "Harness 与上下文", en: "Harness & context" },
    description: { zh: "开发档位、提示词、计划和 Slice", en: "Development tiers, prompts, planning, and Slice" },
  },
  safety: {
    label: { zh: "权限、工作区与安全", en: "Permissions, workspace & safety" },
    description: { zh: "控制写入权限、信任和工作区边界", en: "Control write access, trust, and workspace boundaries" },
  },
  tools: {
    label: { zh: "工具、子代理与任务", en: "Tools, subagents & tasks" },
    description: { zh: "配置工具、子代理和任务执行能力", en: "Configure tools, subagents, and task execution" },
  },
  data: {
    label: { zh: "导入、导出与分享", en: "Import, export & sharing" },
    description: { zh: "迁移、导出或分享聊天资料", en: "Move, export, or share conversation data" },
  },
  remote: {
    label: { zh: "远程与通讯", en: "Remote & messaging" },
    description: { zh: "连接远程客户端与通讯渠道", en: "Connect remote clients and messaging channels" },
  },
  system: {
    label: { zh: "设置、诊断与退出", en: "Settings, diagnostics & exit" },
    description: { zh: "查看状态、设置、快捷键和版本变化", en: "Inspect status, settings, shortcuts, and changes" },
  },
  extensions: {
    label: { zh: "扩展与 Skills", en: "Extensions & skills" },
    description: { zh: "当前会话真实加载的第三方命令", en: "Third-party commands actually loaded in this session" },
  },
};

const PI_COMMANDS: Record<string, CommandMetadata> = {
  settings: { category: "system", description: { zh: "打开 Pi 设置界面", en: "Open Pi settings" } },
  model: { category: "models", description: { zh: "选择当前对话使用的模型", en: "Select the model for this conversation" }, argumentHint: "<provider/model>" },
  "scoped-models": { category: "models", description: { zh: "配置快捷切换时出现的模型", en: "Configure models available to model cycling" } },
  export: { category: "data", description: { zh: "将当前会话导出为 HTML 或 JSONL", en: "Export the current session as HTML or JSONL" }, argumentHint: "[path]" },
  import: { category: "data", description: { zh: "从 JSONL 导入并恢复 Pi 会话", en: "Import and resume a Pi session from JSONL" }, argumentHint: "<path.jsonl>" },
  share: { category: "data", description: { zh: "通过私密 GitHub Gist 分享会话", en: "Share the session as a secret GitHub gist" } },
  copy: { category: "data", description: { zh: "复制上一条模型回复", en: "Copy the last assistant message" } },
  name: { category: "session", description: { zh: "修改当前会话名称", en: "Rename the current session" }, argumentHint: "<name>" },
  session: { category: "session", description: { zh: "查看当前会话信息和统计", en: "Show current session information and statistics" } },
  changelog: { category: "system", description: { zh: "查看 Pi 更新日志", en: "Show Pi changelog entries" } },
  hotkeys: { category: "system", description: { zh: "查看全部键盘快捷键", en: "Show all keyboard shortcuts" } },
  fork: { category: "session", description: { zh: "从旧用户消息创建新分支", en: "Fork from an earlier user message" } },
  clone: { category: "session", description: { zh: "复制当前会话位置为新会话", en: "Duplicate the session at its current position" } },
  tree: { category: "session", description: { zh: "浏览和切换会话分支树", en: "Navigate and switch the session tree" } },
  trust: { category: "safety", description: { zh: "保存当前项目的信任决定", en: "Save the trust decision for this project" } },
  login: { category: "models", description: { zh: "使用 Pi 原生认证登录 Provider", en: "Authenticate a provider through native Pi" }, argumentHint: "<provider>" },
  logout: { category: "models", description: { zh: "移除 Pi 原生 Provider 认证", en: "Remove native Pi provider authentication" } },
  new: { category: "session", description: { zh: "新建空白会话", en: "Start a new session" } },
  compact: { category: "harness", description: { zh: "手动运行 Pi 原生上下文压缩（Slice 的备用路径）", en: "Manually run native Pi compaction (Slice fallback)" } },
  resume: { category: "session", description: { zh: "选择并恢复另一个会话", en: "Select and resume another session" } },
  reload: { category: "system", description: { zh: "重新加载扩展、Skills、主题和上下文文件", en: "Reload extensions, skills, themes, and context files" } },
  quit: { category: "system", description: { zh: "退出 Pi TUI", en: "Quit the Pi TUI" } },
};

const PICODE_COMMANDS: Record<string, CommandMetadata> = {
  "pico-help": { category: "system", description: { zh: "浏览和搜索当前可用的全部命令", en: "Browse and search every command available now" }, argumentHint: "[all|category|command|query]" },
  insert: { category: "session", description: { zh: "在当前工具执行完后插入消息，不中断正在运行的工具", en: "Insert a message after the current tool without cancelling it" }, argumentHint: "<message>" },
  server: { category: "remote", description: { zh: "为当前聊天启动 Picode 远程服务", en: "Start Picode Remote Serve for the current chat" } },
  weixin: { category: "remote", description: { zh: "连接当前聊天与微信 iLink Bot", en: "Connect the current chat to a Weixin iLink Bot" }, argumentHint: "[enable|disable|status]" },
  workspace: { category: "safety", description: { zh: "确认风险后强制切换到新工作区", en: "Force-switch to a new workspace after confirmation" }, argumentHint: "<absolute-directory>" },
  permissions: { category: "safety", description: { zh: "查看或切换当前会话权限档位", en: "Show or switch the session permission tier" }, argumentHint: "[readonly|auto|full|danger-full-access]" },
  harness: { category: "harness", description: { zh: "切换开发档位与验证强度", en: "Switch the development tier and verification strength" }, argumentHint: "[simple|standard|tdd]" },
  "harness-prompt": { category: "harness", description: { zh: "独立调整系统提示词引导强度，不改变 Harness", en: "Adjust prompt guidance without changing the Harness" }, argumentHint: "[none|lean|full]" },
  plan: { category: "harness", description: { zh: "通过 grill-with-docs Skill 开始规划", en: "Plan through the grill-with-docs skill" }, argumentHint: "<goal>" },
  slice: { category: "harness", description: { zh: "封存 Capsule 并无缝进入新的 Pi 会话", en: "Seal a Capsule and continue in a fresh Pi session" }, argumentHint: "<next-intent>" },
  "pico-slice-auto": { category: "harness", description: { zh: "启用、停用或查看实验性自动 Slice", en: "Enable, disable, or inspect experimental automatic Slice" }, argumentHint: "<on|off|status>" },
  "slice-defer": { category: "harness", description: { zh: "将当前硬 Slice 边界延后一次", en: "Defer the active hard Slice boundary once" } },
  thinking: { category: "models", description: { zh: "从当前模型支持的列表选择思考强度", en: "Choose a thinking level supported by the current model" } },
  "pico-login": { category: "models", description: { zh: "登录 Provider 并保存到 Picode Vault", en: "Log in and store a provider in the Picode Vault" }, argumentHint: "<provider>" },
  "pico-logout": { category: "models", description: { zh: "登出 Vault 账号并保留聊天连续性资料", en: "Log out a Vault account while preserving chat continuity" }, argumentHint: "[account-id]" },
  "pico-account": { category: "models", description: { zh: "列出、切换或标记 Picode Vault 账号", en: "List, switch, or label Picode Vault accounts" }, argumentHint: "[list|use <account-id>|label <account-id> <label>]" },
  "pico-import": { category: "data", description: { zh: "打开本机网页账号与聊天导入中心", en: "Open the local account and chat import center" } },
  "cursor-refresh-models": { category: "models", description: { zh: "刷新当前 Cursor 账号的模型目录", en: "Refresh the model catalog for the active Cursor account" } },
  "subagent-model": { category: "tools", description: { zh: "选择子代理模型及其思考强度", en: "Choose the subagent model and thinking level" }, argumentHint: "[provider/model]" },
  "picode-subagent-rpc": { category: "tools", description: { zh: "内部子代理控制桥；通常不需要手动调用", en: "Internal subagent control bridge; normally not called manually" } },
  reinstall: { category: "tools", description: { zh: "重新提示安装缺失的推荐组件", en: "Offer installation of missing recommended components" } },
  "pico-price": { category: "system", description: { zh: "显示完整 Token、缓存、费用和上下文统计", en: "Show complete token, cache, cost, and context statistics" } },
  "pico-webagent": { category: "tools", description: { zh: "配置可选的 Google Search 子代理", en: "Configure the optional Google Search Subagent" }, argumentHint: "[on|off|config|status|doctor|test]" },
};

function commandUsage(name: string, metadata: CommandMetadata): string {
  return `/${name}${metadata.argumentHint === undefined ? "" : ` ${metadata.argumentHint}`}`;
}

function localized(value: LocalizedText, locale: HelpLocale): string {
  return value[locale];
}

function dynamicOwner(command: RuntimeSlashCommand): HelpCommand["owner"] {
  if (PICODE_COMMANDS[command.name] !== undefined) return "picode";
  return command.source === "skill" ? "skill" : "extension";
}

export function buildHelpCatalog(
  runtimeCommands: readonly RuntimeSlashCommand[],
  locale: HelpLocale,
): HelpCategory[] {
  const commands = new Map<string, HelpCommand>();
  for (const [name, metadata] of Object.entries(PI_COMMANDS)) {
    commands.set(name, {
      name,
      usage: commandUsage(name, metadata),
      description: localized(metadata.description, locale),
      category: metadata.category,
      owner: "pi",
    });
  }
  for (const command of runtimeCommands) {
    if (commands.has(command.name)) continue;
    const metadata = PICODE_COMMANDS[command.name];
    const category = metadata?.category ?? "extensions";
    commands.set(command.name, {
      name: command.name,
      usage: metadata === undefined ? `/${command.name}` : commandUsage(command.name, metadata),
      description: metadata === undefined
        ? (command.description?.trim() || (locale === "zh" ? "当前会话加载的扩展命令" : "Command loaded in the current session"))
        : localized(metadata.description, locale),
      category,
      owner: dynamicOwner(command),
    });
  }

  return CATEGORY_ORDER.map((id) => ({
    id,
    label: localized(CATEGORY_TEXT[id].label, locale),
    description: localized(CATEGORY_TEXT[id].description, locale),
    commands: [...commands.values()]
      .filter((command) => command.category === id)
      .sort((left, right) => left.name.localeCompare(right.name)),
  })).filter((category) => category.commands.length > 0);
}

function ownerLabel(owner: HelpCommand["owner"], locale: HelpLocale): string {
  if (owner === "pi") return locale === "zh" ? "Pi 原生" : "Native Pi";
  if (owner === "picode") return "Picode";
  if (owner === "skill") return "Skill";
  return locale === "zh" ? "扩展" : "Extension";
}

export function renderHelpDirectory(catalog: readonly HelpCategory[], locale: HelpLocale): string {
  const heading = locale === "zh"
    ? "Picode 命令目录\n用法：/pico-help <命令|分类|all>；不带参数可交互浏览。"
    : "Picode command directory\nUsage: /pico-help <command|category|all>; omit arguments to browse interactively.";
  const sections = catalog.map((category) => [
    `\n[${category.label}] — ${category.description}`,
    ...category.commands.map((command) =>
      `  ${command.usage} — ${command.description} · ${ownerLabel(command.owner, locale)}`
    ),
  ].join("\n"));
  return [heading, ...sections].join("\n");
}

function renderCategory(category: HelpCategory, locale: HelpLocale): string {
  return [
    `${category.label} — ${category.description}`,
    ...category.commands.map((command) =>
      `${command.usage}\n  ${command.description} · ${ownerLabel(command.owner, locale)}`
    ),
  ].join("\n");
}

function renderCommand(command: HelpCommand, category: HelpCategory, locale: HelpLocale): string {
  const categoryLabel = locale === "zh" ? "分类" : "Category";
  const sourceLabel = locale === "zh" ? "来源" : "Source";
  return [
    command.usage,
    command.description,
    `${categoryLabel}: ${category.label}`,
    `${sourceLabel}: ${ownerLabel(command.owner, locale)}`,
  ].join("\n");
}

function findMatches(catalog: readonly HelpCategory[], rawQuery: string): HelpCommand[] {
  const query = rawQuery.trim().replace(/^\//u, "").toLowerCase();
  if (query === "") return [];
  return catalog.flatMap((category) => category.commands).filter((command) =>
    command.name.toLowerCase().includes(query) ||
    command.description.toLowerCase().includes(query) ||
    command.usage.toLowerCase().includes(query)
  );
}

export function registerPicoHelpCommand(pi: ExtensionAPI, locale: HelpLocale): void {
  pi.registerCommand("pico-help", {
    description: locale === "zh"
      ? "按分类浏览和搜索当前可用的全部命令"
      : "Browse and search all commands available in this session",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const catalog = buildHelpCatalog(pi.getCommands(), locale);
      const query = args.trim();
      if (query.toLowerCase() === "all") {
        ctx.ui.notify(renderHelpDirectory(catalog, locale), "info");
        return;
      }
      if (query !== "") {
        const normalized = query.replace(/^\//u, "").toLowerCase();
        const category = catalog.find((candidate) =>
          candidate.id === normalized || candidate.label.toLowerCase() === normalized
        );
        if (category !== undefined) {
          ctx.ui.notify(renderCategory(category, locale), "info");
          return;
        }
        const exact = catalog.flatMap((candidate) => candidate.commands)
          .find((command) => command.name.toLowerCase() === normalized);
        if (exact !== undefined) {
          const owner = catalog.find((candidate) => candidate.id === exact.category)!;
          ctx.ui.notify(renderCommand(exact, owner, locale), "info");
          return;
        }
        const matches = findMatches(catalog, query);
        if (matches.length === 0) {
          ctx.ui.notify(
            locale === "zh" ? `没有匹配的命令：${query}` : `No command matched: ${query}`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(
          matches.map((command) => `${command.usage} — ${command.description}`).join("\n"),
          "info",
        );
        return;
      }

      const allLabel = locale === "zh" ? "全部命令" : "All commands";
      const selectedCategory = await ctx.ui.select(
        locale === "zh" ? "Picode 帮助目录" : "Picode help directory",
        [...catalog.map((category) => category.label), allLabel],
      );
      if (selectedCategory === undefined) return;
      if (selectedCategory === allLabel) {
        ctx.ui.notify(renderHelpDirectory(catalog, locale), "info");
        return;
      }
      const category = catalog.find((candidate) => candidate.label === selectedCategory);
      if (category === undefined) return;
      const choices = category.commands.map((command) => `/${command.name} — ${command.description}`);
      const selectedCommand = await ctx.ui.select(category.label, choices);
      if (selectedCommand === undefined) return;
      const index = choices.indexOf(selectedCommand);
      const command = category.commands[index];
      if (command !== undefined) ctx.ui.notify(renderCommand(command, category, locale), "info");
    },
  });
}
