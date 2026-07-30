// PROTOTYPE — intentionally throwaway. No real accounts, tasks, or backend mutations.
const variants = [
  { key: "A", name: "Calm Rail" },
  { key: "B", name: "Focus Canvas" },
  { key: "C", name: "Studio Desk" },
];

const query = new URLSearchParams(window.location.search);
const requestedVariant = query.get("variant")?.toUpperCase();

const state = {
  variant: variants.some((item) => item.key === requestedVariant) ? requestedVariant : "A",
  taskKind: "Harness",
  activeConversation: "picode-interface",
  taskDialogOpen: false,
  monitorOpen: false,
  navigationOpen: false,
  draft: "",
  toast: "",
  extraMessages: [],
};

const conversations = [
  {
    id: "picode-interface",
    title: "Picode 主界面设计",
    preview: "比较三套清爽布局",
    time: "刚刚",
    kind: "Harness",
    status: "running",
  },
  {
    id: "cursor-models",
    title: "Cursor 模型列表刷新",
    preview: "已更新 SDK 模型缓存",
    time: "18 分钟",
    kind: "Simple",
    status: "done",
  },
  {
    id: "account-handoff",
    title: "账号接管与继续",
    preview: "等待输入“继续”",
    time: "1 小时",
    kind: "Harness",
    status: "waiting",
  },
  {
    id: "backup",
    title: "聊天备份迁移",
    preview: "跨平台路径验证通过",
    time: "昨天",
    kind: "Harness",
    status: "done",
  },
  {
    id: "provider",
    title: "DeepSeek 自定义 API",
    preview: "OpenAI-compatible provider",
    time: "周一",
    kind: "Simple",
    status: "idle",
  },
];

const iconPaths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>',
  chat: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/>',
  folder: '<path d="M3 7a3 3 0 0 1 3-3h4l2 2h6a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z"/>',
  pulse: '<path d="M3 12h4l2.2-6 4.2 12 2.2-6H21"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 14H3v-4h.08A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.64 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.36 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  arrowUp: '<path d="m12 19V5m-6 6 6-6 6 6"/>',
  paperclip:
    '<path d="m20.5 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5l9.5-9.5a4 4 0 0 1 5.7 5.7l-9.6 9.5a2 2 0 0 1-2.8-2.8l8.8-8.8"/>',
  branch:
    '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M8 8c4 0 4-2 8-2"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  command: '<path d="M18 9a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3Z"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
};

function icon(name, size = 18) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] || ""}</svg>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function taskKindPill() {
  const simple = state.taskKind === "Simple";
  return `<button class="kind-pill ${simple ? "kind-simple" : "kind-harness"}" data-action="new-task" title="切换任务类型">
    ${icon(simple ? "chat" : "layers", 13)}
    <span>${simple ? "Simple" : "Harness"}</span>
  </button>`;
}

function statusDot(status) {
  return `<span class="status-dot status-${status}" aria-label="${status}"></span>`;
}

function conversationItems({ compact = false } = {}) {
  return conversations
    .map(
      (item) => `<button class="conversation-item ${compact ? "is-compact" : ""} ${
        state.activeConversation === item.id ? "is-active" : ""
      }" data-action="select-chat" data-id="${item.id}">
        <span class="conversation-status">${statusDot(item.status)}</span>
        <span class="conversation-copy">
          <span class="conversation-title">${item.title}</span>
          ${compact ? "" : `<span class="conversation-preview">${item.preview}</span>`}
        </span>
        <span class="conversation-meta">
          <span>${item.time}</span>
          ${compact ? "" : `<span class="mini-kind">${item.kind}</span>`}
        </span>
      </button>`,
    )
    .join("");
}

function searchField(label = "搜索聊天") {
  return `<label class="search-field">
    ${icon("search", 15)}
    <input aria-label="${label}" placeholder="${label}" />
    <kbd>⌘ K</kbd>
  </label>`;
}

function brand({ word = true } = {}) {
  return `<div class="brand-mark" aria-label="Picode">
    <span class="brand-glyph">P</span>
    ${word ? '<span class="brand-word">Picode</span>' : ""}
  </div>`;
}

function workspaceMeta() {
  if (state.taskKind === "Simple") {
    return `<span class="meta-chip muted">Scratch Space</span>`;
  }
  return `<span class="meta-chip">D:\\Picode</span><span class="meta-chip">${icon("branch", 13)} ui/prototype</span>`;
}

function modelControl() {
  return `<button class="model-control" data-action="toast" data-message="模型选择器将在正式实现中复用现有 Provider 列表">
    <span class="provider-orb">O</span>
    <span><strong>Codex</strong><small>当前模型</small></span>
    <span class="tiny-chevron">⌄</span>
  </button>`;
}

function activityButton({ label = true } = {}) {
  const count = state.taskKind === "Simple" ? 1 : 2;
  return `<button class="activity-button ${state.monitorOpen ? "is-active" : ""}" data-action="monitor">
    ${icon("pulse", 16)}
    ${label ? `<span>${count} 个运行中</span>` : ""}
    <span class="activity-pulse"></span>
  </button>`;
}

function headerTitle() {
  return `<div class="header-title">
    <strong>Picode 主界面设计</strong>
    <span>原型比较 · 刚刚更新</span>
  </div>`;
}

function conversationThread() {
  const extra = state.extraMessages
    .map(
      (item) =>
        `<article class="message-row user-row"><div class="user-bubble">${escapeHtml(
          item,
        )}</div></article>`,
    )
    .join("");

  return `<div class="thread-scroll">
    <div class="thread-content">
      <div class="conversation-date"><span>今天</span></div>
      <article class="message-row user-row">
        <div class="user-bubble">我希望主界面很简洁和清爽，先设计几套让我比较。</div>
      </article>
      <article class="message-row assistant-row">
        <div class="assistant-avatar">P</div>
        <div class="assistant-content">
          <div class="reasoning-line"><span class="reasoning-spark"></span> 已整理现有界面与产品能力</div>
          <div class="tool-line is-done">
            <span class="tool-icon">${icon("panel", 14)}</span>
            <span class="tool-name">读取当前布局与设计变量</span>
            <span class="tool-path">public/index.html</span>
            <span class="tool-result">${icon("check", 13)} 完成</span>
          </div>
          <div class="tool-line is-done">
            <span class="tool-icon">${icon("pulse", 14)}</span>
            <span class="tool-name">梳理多任务与运行监看入口</span>
            <span class="tool-path">Runtime Monitor</span>
            <span class="tool-result">${icon("check", 13)} 完成</span>
          </div>
          <div class="assistant-prose">
            <p>我把复杂能力收进了三个层级：<strong>聊天始终是主角</strong>，任务类型与模型保持可见，运行状态需要时再展开。</p>
            <p>这套原型提供三种不同方向。你可以用底部切换器或键盘左右键比较，然后告诉我想保留哪一套的哪些部分。</p>
          </div>
          <div class="answer-options">
            <button data-action="switch-variant" data-variant="A"><b>A</b><span>稳定、熟悉、信息收纳最好</span></button>
            <button data-action="switch-variant" data-variant="B"><b>B</b><span>最轻、最适合专注对话</span></button>
            <button data-action="switch-variant" data-variant="C"><b>C</b><span>任务与 Agent 状态最清楚</span></button>
          </div>
        </div>
      </article>
      ${extra}
    </div>
  </div>`;
}

function composer({ floating = false } = {}) {
  return `<div class="composer-wrap ${floating ? "is-floating" : ""}">
    <div class="composer-card">
      <textarea data-composer rows="2" placeholder="给 Picode 发消息…">${escapeHtml(state.draft)}</textarea>
      <div class="composer-toolbar">
        <div class="composer-tools">
          <button class="icon-button" title="添加附件">${icon("paperclip", 17)}</button>
          <button class="tool-text" data-action="toast" data-message="工具只在需要时展开">工具</button>
        </div>
        <div class="composer-send-controls">
          ${modelControl()}
          <button class="send-button" data-action="send" aria-label="发送">${icon("arrowUp", 18)}</button>
        </div>
      </div>
    </div>
    <div class="composer-hint">Enter 发送 · Shift+Enter 换行 · 当前为 ${state.taskKind} Task</div>
  </div>`;
}

function monitorPanel({ embedded = false } = {}) {
  const isSimple = state.taskKind === "Simple";
  return `<aside class="runtime-panel ${embedded ? "is-embedded" : ""}">
    <div class="runtime-header">
      <div><span class="eyebrow">RUNTIME</span><h2>运行监看</h2></div>
      ${embedded ? "" : `<button class="icon-button" data-action="monitor" aria-label="关闭">${icon("x", 17)}</button>`}
    </div>
    <div class="runtime-summary">
      <div><strong>${isSimple ? "1" : "2"}</strong><span>运行中</span></div>
      <div><strong>${isSimple ? "184" : "276"}<small> MB</small></strong><span>总内存</span></div>
      <div><strong>${isSimple ? "1.2" : "6.8"}<small>%</small></strong><span>CPU</span></div>
    </div>
    <div class="runtime-list">
      <div class="agent-run is-primary">
        <div class="agent-line"><span class="agent-icon">P</span><div><strong>主 Agent</strong><span>Codex · 当前模型</span></div><span class="run-state waiting">模型响应中</span></div>
        <div class="resource-line"><span>184 MB</span><span>CPU 1.2%</span><span>12.8k tokens</span></div>
        <div class="progress-track"><i style="width:62%"></i></div>
        <small>最近进展 4 秒前 · 正在生成界面方案</small>
      </div>
      ${
        isSimple
          ? ""
          : `<div class="child-connector"></div>
        <div class="agent-run is-child">
          <div class="agent-line"><span class="agent-icon economy">S</span><div><strong>搜索子 Agent</strong><span>DeepSeek · Search model</span></div><span class="run-state active">运行中</span></div>
          <div class="resource-line"><span>92 MB</span><span>CPU 5.6%</span><span>3.1k tokens</span></div>
          <div class="progress-track"><i style="width:38%"></i></div>
          <small>最近进展 1 秒前 · 读取组件结构</small>
        </div>`
      }
    </div>
    <div class="runtime-section">
      <div class="section-label"><span>后台任务</span><button>查看全部</button></div>
      <div class="background-job"><span class="job-symbol">↻</span><div><strong>索引 Picode</strong><small>等待工具 · 00:42</small></div><span>0.1%</span></div>
      <div class="background-job"><span class="job-symbol done">✓</span><div><strong>检查语言包</strong><small>完成 · 18 秒</small></div><span>0 MB</span></div>
    </div>
    <button class="runtime-footer" data-action="toast" data-message="已选中主 Agent，可查看完整事件和资源历史">打开详细运行记录 ${icon("chevron", 14)}</button>
  </aside>`;
}

function globalRail() {
  return `<nav class="global-rail" aria-label="主导航">
    ${brand({ word: false })}
    <div class="rail-actions">
      <button class="rail-button is-active" title="聊天">${icon("chat", 18)}</button>
      <button class="rail-button" title="工作区">${icon("folder", 18)}</button>
      <button class="rail-button" data-action="monitor" title="运行监看">${icon("pulse", 18)}<i></i></button>
    </div>
    <div class="rail-bottom">
      <button class="rail-button" title="设置">${icon("settings", 18)}</button>
      <span class="profile-dot">A</span>
    </div>
  </nav>`;
}

function sessionPane() {
  return `<aside class="session-pane">
    <div class="pane-top">
      <div class="pane-title"><span>聊天</span><button class="new-task-small" data-action="new-task">${icon("plus", 14)} 新建</button></div>
      ${searchField()}
    </div>
    <div class="conversation-groups">
      <div class="group-label"><span>今天</span><button>${icon("more", 14)}</button></div>
      ${conversationItems()}
    </div>
    <div class="pane-footer">
      <div class="account-mini"><span class="provider-orb">O</span><div><strong>Codex</strong><span>官方账号 · 已连接</span></div></div>
      <button class="icon-button">${icon("more", 17)}</button>
    </div>
  </aside>`;
}

function renderVariantA() {
  return `<section class="prototype variant-a">
    ${globalRail()}
    ${sessionPane()}
    <section class="chat-stage">
      <header class="chat-header">
        ${headerTitle()}
        <div class="header-center">${taskKindPill()}${workspaceMeta()}</div>
        <div class="header-actions">${activityButton()}<button class="icon-button">${icon("more", 18)}</button></div>
      </header>
      ${conversationThread()}
      ${composer()}
    </section>
    ${state.monitorOpen ? `<div class="drawer-backdrop" data-action="monitor"></div>${monitorPanel()}` : ""}
  </section>`;
}

function focusTopbar() {
  return `<header class="focus-topbar">
    <div class="focus-left">
      <button class="icon-button nav-trigger ${state.navigationOpen ? "is-active" : ""}" data-action="navigation">${icon("menu", 18)}</button>
      ${brand()}
    </div>
    <div class="focus-context">${taskKindPill()}<span class="focus-divider"></span>${workspaceMeta()}</div>
    <div class="focus-actions">${activityButton({ label: false })}<button class="new-task-button" data-action="new-task">${icon("plus", 15)} 新建任务</button><span class="profile-dot">A</span></div>
  </header>`;
}

function focusNavigation() {
  return `<aside class="focus-navigation ${state.navigationOpen ? "is-open" : ""}">
    <div class="focus-navigation-head"><h2>最近聊天</h2><button class="icon-button" data-action="navigation">${icon("x", 17)}</button></div>
    ${searchField()}
    <div class="focus-session-list">${conversationItems({ compact: true })}</div>
    <button class="navigation-settings">${icon("settings", 16)} 设置 <span>⌘,</span></button>
  </aside>`;
}

function renderVariantB() {
  return `<section class="prototype variant-b">
    ${focusTopbar()}
    ${state.navigationOpen ? '<div class="nav-scrim" data-action="navigation"></div>' : ""}
    ${focusNavigation()}
    <section class="focus-stage">
      <div class="focus-heading">
        <span class="focus-kicker">正在讨论</span>
        <h1>Picode 主界面设计</h1>
        <p>聊天保持安静，需要的信息在接近使用时出现。</p>
      </div>
      ${conversationThread()}
      ${composer({ floating: true })}
    </section>
    ${state.monitorOpen ? `<div class="drawer-backdrop" data-action="monitor"></div>${monitorPanel()}` : ""}
  </section>`;
}

function projectTree() {
  return `<aside class="project-tree">
    <div class="project-brand">${brand()}<button class="icon-button">${icon("panel", 17)}</button></div>
    <button class="new-task-wide" data-action="new-task">${icon("plus", 15)} 新建任务 <kbd>⌘ N</kbd></button>
    <div class="project-section">
      <div class="project-section-label">工作区</div>
      <button class="project-row is-open"><span class="project-symbol">Pi</span><span><strong>Picode</strong><small>D:\\Picode</small></span><b>3</b></button>
      <div class="project-conversations">${conversationItems({ compact: true })}</div>
      <button class="project-row"><span class="project-symbol muted">G</span><span><strong>Game Project</strong><small>D:\\Game</small></span><b>1</b></button>
    </div>
    <div class="project-footer"><button>${icon("settings", 16)} 设置</button><span class="profile-dot">A</span></div>
  </aside>`;
}

function taskStrip() {
  if (state.taskKind === "Simple") {
    return `<div class="task-strip simple-strip"><span>${icon("chat", 14)} Simple Task</span><p>仅使用 Pi 核心能力 · Scratch Space</p></div>`;
  }
  return `<div class="task-strip">
    <span class="task-strip-title">${icon("layers", 14)} 当前 Harness</span>
    <div class="task-step is-done"><i>${icon("check", 11)}</i><span>梳理需求</span></div>
    <div class="task-line"></div>
    <div class="task-step is-active"><i>2</i><span>界面原型</span></div>
    <div class="task-line"></div>
    <div class="task-step"><i>3</i><span>用户确认</span></div>
    <button>${icon("chevron", 13)}</button>
  </div>`;
}

function renderVariantC() {
  return `<section class="prototype variant-c ${state.monitorOpen ? "monitor-collapsed" : ""}">
    ${projectTree()}
    <section class="desk-chat">
      <header class="desk-header">
        ${headerTitle()}
        <div class="desk-meta">${taskKindPill()}${modelControl()}<button class="icon-button" data-action="monitor" title="折叠监看">${icon("panel", 17)}</button></div>
      </header>
      ${taskStrip()}
      ${conversationThread()}
      ${composer()}
    </section>
    ${state.monitorOpen ? "" : monitorPanel({ embedded: true })}
  </section>`;
}

function taskDialog() {
  if (!state.taskDialogOpen) return "";
  return `<div class="modal-backdrop" data-action="close-task-dialog">
    <section class="task-dialog" role="dialog" aria-modal="true" aria-labelledby="new-task-title" data-dialog>
      <div class="dialog-head"><div><span class="eyebrow">NEW TASK</span><h2 id="new-task-title">你想怎样开始？</h2><p>随时可以从 Simple 转换为 Harness，不会丢失聊天。</p></div><button class="icon-button" data-action="close-task-dialog">${icon("x", 18)}</button></div>
      <div class="task-kind-options">
        <button class="task-kind-option ${state.taskKind === "Simple" ? "is-selected" : ""}" data-action="choose-kind" data-kind="Simple">
          <span class="option-icon simple">${icon("chat", 21)}</span>
          <span><strong>Simple Task</strong><small>立即开始，不选工作区</small></span>
          <p>基础对话与 Pi 核心能力。适合临时问题、轻量搜索和小任务。</p>
          <b>最快开始 ${icon("chevron", 14)}</b>
        </button>
        <button class="task-kind-option ${state.taskKind === "Harness" ? "is-selected" : ""}" data-action="choose-kind" data-kind="Harness">
          <span class="option-icon harness">${icon("layers", 21)}</span>
          <span><strong>Harness Task</strong><small>选择工作区并加载任务模板</small></span>
          <p>适合长期工程、任务清单、证据验证、Git 策略和扩展能力。</p>
          <b>选择工作区 ${icon("chevron", 14)}</b>
        </button>
      </div>
      <label class="remember-choice"><input type="checkbox" /> 下次仍然显示这个选择</label>
    </section>
  </div>`;
}

function prototypeSwitcher() {
  const index = variants.findIndex((item) => item.key === state.variant);
  const current = variants[index];
  const activeCount = state.taskKind === "Simple" ? 1 : 2;
  return `<div class="prototype-switcher" role="toolbar" aria-label="原型方案切换">
    <button data-action="cycle" data-direction="-1" aria-label="上一个方案">←</button>
    <div><strong>${current.key} — ${current.name}</strong><span>${state.taskKind} · ${activeCount} 个 Agent · ← → 切换</span></div>
    <button data-action="cycle" data-direction="1" aria-label="下一个方案">→</button>
  </div>`;
}

function render() {
  const root = document.getElementById("prototype-root");
  const variant =
    state.variant === "B"
      ? renderVariantB()
      : state.variant === "C"
        ? renderVariantC()
        : renderVariantA();
  root.innerHTML = `${variant}${taskDialog()}${state.toast ? `<div class="prototype-toast">${escapeHtml(state.toast)}</div>` : ""}${prototypeSwitcher()}`;
  document.documentElement.dataset.prototypeVariant = state.variant;
  attachEvents();
}

function setVariant(key) {
  if (!variants.some((item) => item.key === key)) return;
  state.variant = key;
  state.monitorOpen = false;
  state.navigationOpen = false;
  const nextQuery = new URLSearchParams(window.location.search);
  nextQuery.set("variant", key);
  window.history.replaceState({}, "", `${window.location.pathname}?${nextQuery.toString()}`);
  render();
}

let toastTimer;
function showToast(message) {
  window.clearTimeout(toastTimer);
  state.toast = message;
  render();
  toastTimer = window.setTimeout(() => {
    state.toast = "";
    render();
  }, 2200);
}

function cycleVariant(direction) {
  const index = variants.findIndex((item) => item.key === state.variant);
  const next = (index + Number(direction) + variants.length) % variants.length;
  setVariant(variants[next].key);
}

function attachEvents() {
  document.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", (event) => {
      const action = element.dataset.action;
      if (action === "cycle") cycleVariant(element.dataset.direction);
      if (action === "switch-variant") setVariant(element.dataset.variant);
      if (action === "new-task") {
        state.taskDialogOpen = true;
        render();
      }
      if (
        action === "close-task-dialog" &&
        (event.target === element || element.closest("button"))
      ) {
        state.taskDialogOpen = false;
        render();
      }
      if (action === "choose-kind") {
        state.taskKind = element.dataset.kind;
        state.taskDialogOpen = false;
        showToast(`${state.taskKind} Task 已应用到原型状态`);
      }
      if (action === "monitor") {
        state.monitorOpen = !state.monitorOpen;
        render();
      }
      if (action === "navigation") {
        state.navigationOpen = !state.navigationOpen;
        render();
      }
      if (action === "select-chat") {
        state.activeConversation = element.dataset.id;
        showToast(
          `已切换到：${conversations.find((item) => item.id === state.activeConversation)?.title}`,
        );
      }
      if (action === "toast") showToast(element.dataset.message);
      if (action === "send") {
        const composer = document.querySelector("[data-composer]");
        const value = composer?.value.trim();
        if (value) {
          state.extraMessages.push(value);
          state.draft = "";
          showToast("原型消息已加入当前会话（仅内存）");
        }
      }
    });
  });

  document.querySelectorAll("[data-dialog]").forEach((dialog) => {
    dialog.addEventListener("click", (event) => event.stopPropagation());
  });

  const composer = document.querySelector("[data-composer]");
  if (composer) {
    composer.addEventListener("input", () => {
      state.draft = composer.value;
    });
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        document.querySelector('[data-action="send"]')?.click();
      }
    });
  }
}

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing =
    target instanceof HTMLElement &&
    (target.matches("input, textarea") || target.isContentEditable);
  if (!editing && event.key === "ArrowLeft") cycleVariant(-1);
  if (!editing && event.key === "ArrowRight") cycleVariant(1);
  if (event.key === "Escape") {
    state.taskDialogOpen = false;
    state.monitorOpen = false;
    state.navigationOpen = false;
    render();
  }
});

render();
