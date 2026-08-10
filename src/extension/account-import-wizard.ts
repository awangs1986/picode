import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AccountsManager } from "../store/accounts.ts";
import type { ChatArchiveFilter, ChatCatalogScan, ChatSort } from "./chat-import-catalog.ts";
import {
  parseAccountJson,
  scanLocalAccountCandidates,
  type AccountImportCandidate,
} from "./account-source-scanner.ts";
import {
  discoverLocalChatSources,
  type ChatSource,
  type ChatSourceLocations,
} from "./chat-source-discovery.ts";

export type WizardCompletion =
  | {
      status: "imported";
      provider?: string;
      accountId?: string;
      importedAccountIds: string[];
      importedChatCount?: number;
      activeAccountChanged: boolean;
      warnings: string[];
    }
  | { status: "cancelled" }
  | { status: "timed_out" };

export interface AccountImportWizard {
  url: URL;
  completion: Promise<WizardCompletion>;
  cancel(): void;
  browserOpened: boolean;
}

export type AccountImportCompleteHandler = (
  completion: Extract<WizardCompletion, { status: "imported" }>,
) => Promise<void> | void;

export interface WizardChatImport {
  scan(input: {
    source: string;
    path: string;
    archiveFilter: ChatArchiveFilter;
    sort: ChatSort;
  }): Promise<ChatCatalogScan>;
  apply(input: {
    scanId: string;
    candidateIds: string[];
    workspaceBindings: Record<string, string>;
    includeReasoning: boolean;
  }): Promise<unknown>;
}

export const DEFAULT_ACCOUNT_IMPORT_TIMEOUT_MS = 15 * 60 * 1_000;

const WIZARD_CSS = `
:root{color-scheme:light;--bg:#f4f1eb;--panel:#fffdf9;--side:#ece8e0;--line:#ddd7cc;--ink:#25231f;--muted:#777168;--accent:#b45a38;--accent-soft:#f6e3d9;--ok:#347c5a;--warn:#8a5a15}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;overflow-x:hidden}body{background:var(--bg);color:var(--ink);font:14px/1.5 Inter,"Segoe UI",system-ui,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}.topbar{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid var(--line);background:rgba(255,253,249,.94)}.brand{display:flex;align-items:center;gap:10px;font-weight:740}.mark{display:grid;place-items:center;width:29px;height:29px;border-radius:9px;background:var(--ink);color:#fff;font-size:12px}.muted{color:var(--muted)}.badge{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--muted);font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}.layout{display:grid;grid-template-columns:286px minmax(0,1fr);min-height:calc(100vh - 58px)}.sidebar{padding:24px 17px;background:var(--side);border-right:1px solid var(--line)}.side-label{padding:0 10px 7px;color:var(--muted);font-size:12px}.nav{display:flex;align-items:center;gap:11px;width:100%;margin-bottom:4px;padding:11px;border:0;border-radius:11px;background:transparent;color:var(--ink);text-align:left;text-decoration:none}.nav.active{background:#fff;box-shadow:0 1px 5px rgba(42,34,24,.08)}.nav-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#e1ddd5;font-weight:760}.nav.active .nav-icon{background:var(--accent-soft);color:var(--accent)}.nav-copy{min-width:0;flex:1}.nav-copy strong,.nav-copy small{display:block}.nav-copy small{color:var(--muted)}.notice{margin-top:22px;padding:14px;border-top:1px solid #d2ccc1;color:var(--muted);font-size:12px}.main{min-width:0;padding:30px 34px 100px}.main-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:22px}.title{margin:0 0 6px;font-size:25px;line-height:1.2}.card{background:var(--panel);border:1px solid var(--line);border-radius:15px}.section{padding:20px;margin-bottom:16px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}.section-title{margin:0;font-size:15px}.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.field-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}.label{display:block;color:var(--muted);font-size:12px}.field{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);outline:none}.field:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}textarea.field{resize:vertical}.btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:10px;background:#fff;padding:9px 13px;color:var(--ink);text-decoration:none}.btn:hover{border-color:#aaa196}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn-row{display:flex;justify-content:flex-end;gap:9px;margin-top:15px}.account-list{display:grid;gap:10px}.account-card{display:grid;grid-template-columns:24px 40px minmax(0,1fr) auto;align-items:center;gap:12px;padding:13px;border:1px solid var(--line);border-radius:12px;background:#fff}.source-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:#eee9e1;font-weight:760}.account-card small{display:block;color:var(--muted)}.activate{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}.warning{margin:8px 0 0;padding:8px 10px;border-radius:9px;background:#fff3dc;color:var(--warn);font-size:12px}.empty{padding:32px;text-align:center;color:var(--muted)}.source-tabs{display:flex;gap:8px;margin-bottom:13px}.source-tabs .active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}.toolbar{display:grid;grid-template-columns:minmax(240px,1fr) 160px 170px auto;gap:9px;align-items:end}.toolbar .field{margin-top:0}.result-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:18px 0 10px}.pill{display:inline-flex;padding:5px 9px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--muted);font-size:12px}.chat-list{padding:3px 16px}.chat-row{display:grid;grid-template-columns:24px minmax(0,1fr) 130px;gap:12px;padding:15px 6px;border-bottom:1px solid var(--line)}.chat-row:last-child{border-bottom:0}.chat-row h3{margin:0 0 4px;font-size:14px}.snippet{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}.chat-meta{text-align:right;color:var(--muted);font-size:12px}.workspace{display:grid;grid-template-columns:minmax(180px,1fr) minmax(260px,1.2fr);align-items:end;gap:14px;padding:14px 0;border-bottom:1px solid var(--line)}.workspace:last-child{border-bottom:0}.sticky-action{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:18px;margin:20px -34px -100px;padding:14px 34px;background:rgba(244,241,235,.95);border-top:1px solid var(--line);backdrop-filter:blur(14px)}.checkbox{width:16px;height:16px;accent-color:var(--accent)}.security{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.divider{height:1px;background:var(--line);margin:18px 0}.error{padding:14px;border:1px solid #e2b7a8;border-radius:11px;background:#fff0eb;color:#8d3c25}
@media(max-width:900px){.layout{grid-template-columns:1fr}.sidebar{display:flex;gap:8px;padding:10px 14px;border-right:0;border-bottom:1px solid var(--line)}.side-label,.notice{display:none}.nav{margin:0}.nav-copy small{display:none}.main{padding:22px 16px 80px}.toolbar,.field-grid,.field-grid.three{grid-template-columns:1fr}.sticky-action{margin-left:-16px;margin-right:-16px;margin-bottom:-80px;padding-left:16px;padding-right:16px}.chat-row{grid-template-columns:24px minmax(0,1fr)}.chat-meta{display:none}.workspace{grid-template-columns:1fr}.topbar{padding:0 16px}}
`;

export async function startAccountImportWizard(options: {
  accounts: AccountsManager;
  openBrowser: (url: string) => Promise<void>;
  timeoutMs?: number;
  discoverAccounts?: () => Promise<AccountImportCandidate[]>;
  discoverChatSources?: () => Promise<ChatSourceLocations>;
  chatImport?: WizardChatImport;
  /** Refresh the live Pi provider registry after credentials are durably saved. */
  onImported?: AccountImportCompleteHandler;
}): Promise<AccountImportWizard> {
  const bootstrapToken = randomBytes(24).toString("hex");
  const sessionToken = randomBytes(32).toString("hex");
  let bootstrapAvailable = true;
  let settle!: (value: WizardCompletion) => void;
  let settled = false;
  let pendingCompletion: Extract<WizardCompletion, { status: "imported" }> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const lifetimeMs = options.timeoutMs ?? DEFAULT_ACCOUNT_IMPORT_TIMEOUT_MS;
  const candidates = await (options.discoverAccounts ?? scanLocalAccountCandidates)();
  const chatSources = options.chatImport === undefined
    ? undefined
    : await (options.discoverChatSources ?? discoverLocalChatSources)();
  const candidatesById = new Map(candidates.map((item) => [item.id, item]));
  const escapeHtml = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const renderCandidates = (items: readonly AccountImportCandidate[]): string => items.length === 0
    ? `<div class="card empty">没有发现支持的本机账号。你仍可以导入 JSON 或手动添加 API。</div>`
    : `<form method="post" action="/import-candidates"><div class="account-list">${items.map((item) =>
      `<label class="account-card"><input class="checkbox" type="checkbox" name="candidateId" value="${escapeHtml(item.id)}"><span class="source-icon">${escapeHtml(item.provider.slice(0, 2).toUpperCase())}</span><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.summary)}</small>${item.warnings.map((warning) => `<span class="warning" role="alert">${escapeHtml(warning)}</span>`).join("")}</span>${item.chatCompatible ? `<span class="activate"><input class="checkbox" type="radio" name="activateCandidateId" value="${escapeHtml(item.id)}">导入后启用</span>` : `<span class="pill">仅备份</span>`}</label>`
    ).join("")}</div><div class="btn-row"><button class="btn primary" type="submit">导入所选账号</button></div></form>`;
  const renderPage = (view: "accounts" | "chats", heading: string, subheading: string, content: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(heading)} · Picode</title><style>${WIZARD_CSS}</style></head>
<body data-layout="chat-browser"><header class="topbar"><div class="brand"><span class="mark">Pi</span><span>Picode</span><span class="muted">/ 导入中心</span></div><span class="badge"><span class="dot"></span>仅在本机运行 · ${Math.max(1, Math.ceil(lifetimeMs / 60_000))} 分钟有效</span></header><div class="layout"><aside class="sidebar"><div class="side-label">导入内容</div><a class="nav ${view === "accounts" ? "active" : ""}" href="/import?view=accounts"><span class="nav-icon">⌁</span><span class="nav-copy"><strong>账号</strong><small>${candidates.length} 个候选</small></span></a>${options.chatImport === undefined ? "" : `<a class="nav ${view === "chats" ? "active" : ""}" href="/import?view=chats"><span class="nav-icon">☵</span><span class="nav-copy"><strong>聊天记录</strong><small>选择、筛选与绑定</small></span></a>`}<div class="notice">凭据只发送给本次临时本地服务。导入账号不会自动替换当前账号；跨系统聊天必须重新绑定工作区。</div></aside><main class="main"><div class="main-head"><div><h1 class="title">${escapeHtml(heading)}</h1><div class="muted">${escapeHtml(subheading)}</div></div></div>${content}</main></div></body></html>`;
  const completion = new Promise<WizardCompletion>((resolve) => { settle = resolve; });
  const finish = (value: WizardCompletion): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    settle(value);
    server.close();
  };
  const rememberImport = (value: Extract<WizardCompletion, { status: "imported" }>): void => {
    if (pendingCompletion === undefined) {
      pendingCompletion = value;
      return;
    }
    const provider = value.provider ?? pendingCompletion.provider;
    const accountId = value.accountId ?? pendingCompletion.accountId;
    pendingCompletion = {
      status: "imported",
      ...(provider === undefined ? {} : { provider }),
      ...(accountId === undefined ? {} : { accountId }),
      importedAccountIds: [...new Set([...pendingCompletion.importedAccountIds, ...value.importedAccountIds])],
      importedChatCount: (pendingCompletion.importedChatCount ?? 0) + (value.importedChatCount ?? 0),
      activeAccountChanged: pendingCompletion.activeAccountChanged || value.activeAccountChanged,
      warnings: [...pendingCompletion.warnings, ...value.warnings],
    };
  };
  const notifyImported = async (value: Extract<WizardCompletion, { status: "imported" }>): Promise<void> => {
    if (value.importedAccountIds.length === 0 || options.onImported === undefined) {
      rememberImport(value);
      return;
    }
    try {
      await options.onImported(value);
    } catch (cause) {
      value.warnings.push(`账号已保存，但当前 Pi 会话未刷新：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    rememberImport(value);
  };
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (req.method === "GET" && requestUrl.pathname === `/${bootstrapToken}/`) {
      if (!bootstrapAvailable) {
        res.writeHead(410, headers).end("bootstrap link already used");
        return;
      }
      bootstrapAvailable = false;
      res.writeHead(303, {
        ...headers,
        location: "/import",
        "set-cookie": `picode_import=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.ceil(lifetimeMs / 1_000))}`,
      }).end();
      return;
    }
    const authenticated = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .includes(`picode_import=${sessionToken}`);
    if (!authenticated) {
      res.writeHead(403, headers).end("forbidden");
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/import") {
      const view = requestUrl.searchParams.get("view") === "chats" && options.chatImport !== undefined ? "chats" : "accounts";
      const requestedSource = requestUrl.searchParams.get("source");
      const selectedSource: ChatSource = requestedSource === "cursor" || requestedSource === "claude-code"
        ? requestedSource
        : "codex";
      const selectedLocation = chatSources?.[selectedSource];
      const sourceLabels: Record<ChatSource, string> = {
        codex: "Codex",
        cursor: "Cursor",
        "claude-code": "Claude",
      };
      const sourceTabs = (Object.keys(sourceLabels) as ChatSource[]).map((source) =>
        `<a class="btn ${source === selectedSource ? "active" : ""}" href="/import?view=chats&amp;source=${source}">${sourceLabels[source]}</a>`
      ).join("");
      const pathOptions = (selectedLocation?.candidates ?? [])
        .map((path) => `<option value="${escapeHtml(path)}"></option>`)
        .join("");
      const candidateRows = renderCandidates(candidates);
      const accountContent = `<section class="card section"><div class="section-head"><div><h2 class="section-title">本机发现的账号</h2><div class="muted">选择要保存的账号，并单独决定是否立即启用。</div></div><span class="pill">${candidates.length} 个候选</span></div>${candidateRows}</section><section class="card section"><h2 class="section-title">导入账号 JSON</h2><form method="post" action="/preview-json"><div class="field-grid"><label class="label">来源格式<select class="field" name="kind"><option value="codex">Codex</option><option value="claude">Claude</option><option value="cursor">Cursor</option><option value="custom">自定义 API</option></select></label><label class="label">JSON 快照<textarea class="field" name="json" rows="5" required placeholder="粘贴账号 JSON；最大 1 MB"></textarea></label></div><div class="btn-row"><button class="btn" type="submit">预览 JSON</button></div></form><div class="divider"></div><h2 class="section-title">手动添加 API</h2><form method="post" action="/submit"><div class="field-grid three"><label class="label">Provider<input class="field" name="provider" required placeholder="openai / anthropic / cursor"></label><label class="label">账号名称<input class="field" name="label" required></label><label class="label">API Key / Access Token<input class="field" name="accessToken" type="password" required autocomplete="off"></label><label class="label">Refresh Token（可选）<input class="field" name="refreshToken" type="password" autocomplete="off"></label><label class="label">Base URL（可选）<input class="field" name="baseUrl" type="url" placeholder="https://example.com/v1"></label><label class="label">默认模型（可选）<input class="field" name="defaultModel"></label></div><div class="btn-row"><label class="security"><input class="checkbox" type="checkbox" name="activateAfterImport" value="yes" checked>保存后立即启用</label><button class="btn primary" type="submit">保存账号</button></div></form></section>`;
      const chatContent = options.chatImport === undefined ? "" : `<section class="card section"><div class="section-head"><div><h2 class="section-title">扫描本机聊天</h2><div class="muted">已自动嗅探当前来源的历史目录；路径可直接修改。扫描只读取标题和最后一条可见对话。</div></div>${(selectedLocation?.candidates.length ?? 0) > 0 ? `<span class="pill">已检测目录</span>` : `<span class="pill">使用常规路径</span>`}</div><div class="source-tabs">${sourceTabs}</div><form method="post" action="/chat-scan"><input type="hidden" name="source" value="${selectedSource}"><div class="toolbar"><label class="label">聊天文件或目录<input class="field" name="path" list="chat-source-paths" required value="${escapeHtml(selectedLocation?.defaultPath ?? "")}" placeholder="选择或粘贴历史目录路径"><datalist id="chat-source-paths">${pathOptions}</datalist></label><label class="label">归档状态<select class="field" name="archiveFilter"><option value="active">仅非归档</option><option value="all">全部</option><option value="archived">仅归档</option></select></label><label class="label">排序<select class="field" name="sort"><option value="updated-desc">时间：最新优先</option><option value="updated-asc">时间：最早优先</option><option value="size-desc">大小：从大到小</option><option value="size-asc">大小：从小到大</option></select></label><button class="btn primary" type="submit">扫描聊天</button></div></form></section><div class="card empty">扫描后将在这里显示聊天标题、最近内容、时间、大小和工作区分组。</div>`;
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(view === "chats"
        ? renderPage("chats", "选择聊天记录", "筛选、检查并按原工作区分组绑定到当前机器。", chatContent)
        : renderPage("accounts", "导入账号", "扫描本机配置、导入 JSON，或手动连接兼容 API。", accountContent));
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/chat-scan" && options.chatImport !== undefined) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const source = form.get("source") ?? "";
      const path = form.get("path") ?? "";
      const archiveFilter = form.get("archiveFilter");
      const sort = form.get("sort");
      if (path.trim() === "" || !["active", "archived", "all"].includes(archiveFilter ?? "")) {
        res.writeHead(400, headers).end("invalid chat scan request");
        return;
      }
      if (!["updated-desc", "updated-asc", "size-desc", "size-asc"].includes(sort ?? "")) {
        res.writeHead(400, headers).end("invalid chat sort");
        return;
      }
      try {
        const scan = await options.chatImport.scan({
          source,
          path,
          archiveFilter: archiveFilter as ChatArchiveFilter,
          sort: sort as ChatSort,
        });
        const groups = scan.workspaceGroups.map((group) =>
          `<label class="workspace"><span><strong>${escapeHtml(group.originalWorkspace ?? "未分配工作区")}</strong><small class="muted">${group.candidateCount} 条聊天 · ${escapeHtml(group.source)}</small></span><span class="label">绑定到本机目录<input class="field" name="workspace.${escapeHtml(group.id)}" required placeholder="输入当前系统中已存在的目录"></span></label>`
        ).join("");
        const rows = scan.candidates.map((candidate) =>
          `<label class="chat-row"><input class="checkbox" type="checkbox" name="candidateId" value="${escapeHtml(candidate.id)}"><span><h3>${escapeHtml(candidate.title)}</h3><div class="snippet">${escapeHtml(candidate.lastMessageSnippet)}</div><small class="muted">工作区：${escapeHtml(candidate.originalWorkspace ?? "未识别")} · ${escapeHtml(candidate.source)}${candidate.archived ? " · 已归档" : ""}</small></span><span class="chat-meta">${escapeHtml(candidate.updatedAt)}<br>${Math.max(1, Math.round(candidate.fileSizeBytes / 1024))} KB</span></label>`
        ).join("");
        res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
        const resultContent = `<div class="result-bar"><div><span class="pill">找到 ${scan.candidates.length} 条</span> <span class="pill">跳过 ${scan.duplicatesSkipped} 条重复项</span></div><a class="btn" href="/import?view=chats">重新扫描</a></div><form method="post" action="/import-chats"><input type="hidden" name="scanId" value="${escapeHtml(scan.scanId)}"><section class="card chat-list">${rows || `<div class="empty">当前筛选条件下没有聊天。</div>`}</section><section class="card section" style="margin-top:16px"><h2 class="section-title">工作区绑定</h2><div class="muted">路径不会从其他系统直接复用；所选聊天必须绑定到本机存在的目录。</div>${groups}</section><div class="sticky-action"><label class="security"><input class="checkbox" type="checkbox" name="includeReasoning" value="yes">导入思考过程（完整记录中默认折叠）</label><button class="btn primary" type="submit">导入所选聊天</button></div></form>`;
        res.end(renderPage("chats", "选择聊天记录", "这里只显示真实对话摘要；工具日志和思考过程默认隐藏。", resultContent));
      } catch (cause) {
        res.writeHead(422, headers).end(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/import-chats" && options.chatImport !== undefined) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const candidateIds = [...new Set(form.getAll("candidateId"))];
      const scanId = form.get("scanId") ?? "";
      if (scanId === "" || candidateIds.length === 0) {
        res.writeHead(400, headers).end("select at least one chat");
        return;
      }
      const workspaceBindings: Record<string, string> = {};
      for (const [name, value] of form) {
        if (name.startsWith("workspace.") && value.trim() !== "") {
          workspaceBindings[name.slice("workspace.".length)] = value;
        }
      }
      try {
        const result = await options.chatImport.apply({
          scanId,
          candidateIds,
          workspaceBindings,
          includeReasoning: form.get("includeReasoning") === "yes",
        });
        rememberImport({
          status: "imported",
          importedAccountIds: [],
          importedChatCount: candidateIds.length,
          activeAccountChanged: false,
          warnings: [],
        });
        res.writeHead(201, { ...headers, "content-type": "text/html; charset=utf-8" });
        res.end(renderPage("chats", "聊天记录已导入", `已导入 ${candidateIds.length} 条聊天记录。`, `<section class="card section"><div class="section-head"><div><h2 class="section-title">导入成功</h2><div class="muted">聊天副本已写入 Picode；原始记录没有被修改。</div></div><span class="badge"><span class="dot"></span>${candidateIds.length} 条</span></div><div class="btn-row"><a class="btn" href="/import?view=accounts">返回账号</a><a class="btn" href="/import?view=chats">继续导入聊天</a><form method="post" action="/finish"><button class="btn primary" type="submit">完成并关闭</button></form></div></section>`));
      } catch (cause) {
        res.writeHead(422, headers).end(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/preview-json") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 1_048_576) {
          res.writeHead(413, headers).end("JSON snapshot is too large");
          return;
        }
        chunks.push(buffer);
      }
      try {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const kind = form.get("kind");
        if (kind !== "codex" && kind !== "claude" && kind !== "cursor" && kind !== "custom") {
          res.writeHead(400, headers).end("unsupported source format");
          return;
        }
        const parsed = parseAccountJson(kind, form.get("json") ?? "", "uploaded JSON");
        for (const item of parsed) candidatesById.set(item.id, item);
        res.writeHead(parsed.length === 0 ? 422 : 200, {
          ...headers,
          "content-type": "text/html; charset=utf-8",
        });
        res.end(parsed.length === 0
          ? renderPage("accounts", "没有找到账号", "请检查 JSON 格式或改用手动添加。", `<div class="error">JSON 中没有可识别的账号。</div>`)
          : renderPage("accounts", "确认 JSON 账号", "检查候选账号并选择是否立即启用。", `<section class="card section">${renderCandidates(parsed)}</section>`));
      } catch {
        res.writeHead(400, headers).end("invalid JSON account snapshot");
      }
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/cancel") {
      res.writeHead(204, headers).end();
      finish({ status: "cancelled" });
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/finish") {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(renderPage("accounts", "导入已完成", "可以安全关闭这个页面并返回 Picode。", `<section class="card section"><h2 class="section-title">导入中心已关闭</h2><p class="muted">所有已确认的更改均已保存。</p></section>`));
      finish(pendingCompletion ?? { status: "cancelled" });
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/import-candidates") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const selectedIds = [...new Set(form.getAll("candidateId"))];
      const selected = selectedIds.map((id) => candidatesById.get(id));
      if (selectedIds.length === 0 || selected.some((candidate) => candidate === undefined)) {
        res.writeHead(400, headers).end("select at least one detected account");
        return;
      }
      const candidates = selected as AccountImportCandidate[];
      const activateCandidateId = form.get("activateCandidateId") ?? undefined;
      if (activateCandidateId !== undefined && !selectedIds.includes(activateCandidateId)) {
        res.writeHead(400, headers).end("active account must be selected for import");
        return;
      }
      const imported = await options.accounts.importMany(candidates.map((candidate) => ({
        stableId: candidate.id,
        provider: candidate.provider,
        piProvider: candidate.piProvider,
        label: candidate.label,
        credentials: candidate.credentials,
        authKind: candidate.authKind,
        chatCompatible: candidate.chatCompatible,
        warnings: candidate.warnings,
        ...(candidate.endpoint === undefined ? {} : { endpoint: candidate.endpoint }),
        ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
        ...(candidate.defaultModel === undefined ? {} : { defaultModel: candidate.defaultModel }),
      })), activateCandidateId);
      if (!imported.ok) {
        res.writeHead(500, headers).end(imported.error.message);
        return;
      }
      const active = imported.value.find((account) => account.status === "active");
      const firstImported = imported.value[0];
      const outcome: Extract<WizardCompletion, { status: "imported" }> = {
        status: "imported",
        ...(imported.value.length === 1 && firstImported !== undefined ? {
          provider: firstImported.provider,
          accountId: firstImported.id,
        } : {}),
        importedAccountIds: imported.value.map((account) => account.id),
        activeAccountChanged: active !== undefined,
        warnings: candidates.flatMap((candidate) => candidate.warnings),
      };
      await notifyImported(outcome);
      const importedRows = imported.value.map((account) =>
        `<div class="account-card"><span></span><span class="source-icon">${escapeHtml(account.provider.slice(0, 2).toUpperCase())}</span><span><strong>${escapeHtml(account.label)}</strong><small>${escapeHtml(account.provider)} · ${account.status === "active" ? "已启用" : "已保存"}</small></span><span class="pill">${account.status === "active" ? "当前账号" : "已存储"}</span></div>`
      ).join("");
      const warningRows = outcome.warnings.map((warning) =>
        `<div class="warning" role="alert">${escapeHtml(warning)}</div>`
      ).join("");
      res.writeHead(201, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(renderPage(
        "accounts",
        "账号已导入",
        active === undefined ? "账号已安全保存，当前会话账号未改变。" : "账号已保存并加载到当前 Pi 会话。",
        `<section class="card section"><div class="section-head"><div><h2 class="section-title">导入成功</h2><div class="muted">共保存 ${imported.value.length} 个账号。</div></div><span class="badge"><span class="dot"></span>${active === undefined ? "已保存" : "已启用"}</span></div><div class="account-list">${importedRows}</div>${warningRows}<div class="btn-row">${options.chatImport === undefined ? "" : `<a class="btn primary" href="/import?view=chats">继续导入聊天记录</a>`}<form method="post" action="/finish"><button class="btn" type="submit">完成并关闭</button></form></div></section>`,
      ));
      if (options.chatImport === undefined) finish(outcome);
      return;
    }
    if (req.method !== "POST" || requestUrl.pathname !== "/submit") {
      res.writeHead(404, headers).end("not found");
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 1_048_576) throw new Error("payload too large");
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const jsonRequest = req.headers["content-type"]?.startsWith("application/json") === true;
      const body = jsonRequest
        ? JSON.parse(raw) as Record<string, unknown>
        : Object.fromEntries(new URLSearchParams(raw));
      if (typeof body.provider !== "string" || typeof body.label !== "string" || typeof body.accessToken !== "string") {
        res.writeHead(400, headers).end("invalid account payload");
        return;
      }
      const provider = body.provider.trim().toLowerCase();
      const cursorApiKey = provider === "cursor";
      const imported = await options.accounts.importCredentials({
        provider,
        piProvider: provider,
        label: body.label,
        credentials: {
          accessToken: body.accessToken,
          ...(typeof body.refreshToken === "string" ? { refreshToken: body.refreshToken } : {}),
          ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
        },
        authKind: "api_key",
        chatCompatible: true,
        ...(cursorApiKey ? { metadata: { credentialKind: "cursor_sdk_api_key" } } : {}),
        ...(typeof body.baseUrl === "string" || typeof body.defaultModel === "string" ? {
          endpoint: {
            ...(typeof body.baseUrl === "string" && body.baseUrl !== "" ? { baseUrl: body.baseUrl } : {}),
            ...(typeof body.defaultModel === "string" && body.defaultModel !== "" ? { model: body.defaultModel } : {}),
          },
        } : {}),
        ...(typeof body.defaultModel === "string" ? { defaultModel: body.defaultModel } : {}),
      });
      if (!imported.ok) {
        res.writeHead(500, headers).end(imported.error.message);
        return;
      }
      const shouldActivate = body.activateAfterImport === "yes" || body.activateAfterImport === true;
      const activated = shouldActivate ? await options.accounts.setActive(imported.value.id) : imported;
      if (!activated.ok) {
        res.writeHead(500, headers).end(activated.error.message);
        return;
      }
      res.writeHead(201, { ...headers, "content-type": jsonRequest ? "application/json" : "text/html; charset=utf-8" });
      res.end(jsonRequest
        ? JSON.stringify(activated.value)
        : renderPage("accounts", `${body.label} 已保存${shouldActivate ? "并启用" : ""}`, cursorApiKey ? "Cursor 模型将在新的 Pi 会话中使用这个 SDK API Key。" : "账号已经写入 Picode Account Vault。", `<section class="card section"><div class="section-head"><div><h2 class="section-title">保存成功</h2><div class="muted">Provider：${escapeHtml(provider)} · 状态：${shouldActivate ? "已启用" : "已保存"}</div></div><span class="badge"><span class="dot"></span>凭据已安全写入</span></div><p>${options.chatImport === undefined ? "你现在可以关闭这个页面并返回 Picode。" : "导入中心仍在运行，可以继续连接聊天记录。"}</p>${options.chatImport === undefined ? "" : `<div class="btn-row"><a class="btn primary" href="/import?view=chats">继续导入聊天记录</a><form method="post" action="/finish"><button class="btn" type="submit">完成并关闭</button></form></div>`}</section>`));
      const outcome: Extract<WizardCompletion, { status: "imported" }> = {
        status: "imported",
        provider: activated.value.provider,
        accountId: activated.value.id,
        importedAccountIds: [activated.value.id],
        activeAccountChanged: shouldActivate,
        warnings: [],
      };
      await notifyImported(outcome);
      if (options.chatImport === undefined) finish(outcome);
    } catch {
      res.writeHead(400, headers).end("invalid account payload");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("wizard did not bind a TCP port");
  const url = new URL(`http://127.0.0.1:${address.port}/${bootstrapToken}/`);
  timer = setTimeout(() => finish({ status: "timed_out" }), lifetimeMs);
  let browserOpened = true;
  const browserAttempt = options.openBrowser(url.toString()).catch(() => {
    browserOpened = false;
  });
  // Desktop URL handlers can remain pending even though the browser has already
  // been handed the URL.  The loopback URL is the headless contract, so never
  // hold it hostage to the platform launcher.  One event-loop turn still lets
  // an immediate launch failure update the fallback diagnostic.
  await Promise.race([
    browserAttempt,
    new Promise<void>((resolve) => setImmediate(resolve)),
  ]);
  return { url, completion, browserOpened, cancel: () => finish({ status: "cancelled" }) };
}
