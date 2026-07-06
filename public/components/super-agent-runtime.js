/**
 * <super-agent-runtime> Web Component
 *
 * Replaces the SuperAgentRuntime class + initRuntimeCollapse in super-agent-panel.js.
 * Renders its own HTML, polls /api/super-agent/tasks every 3s.
 *
 * Usage:
 *   <super-agent-runtime id="super-agent-runtime"></super-agent-runtime>
 *
 * Dispatches a custom event "sa-dispatch" with task detail when Approve is clicked.
 * The host page should listen: el.addEventListener('sa-dispatch', e => ...)
 */

import { setupResizablePanel } from "../resizable-panel.js";

class SuperAgentRuntime extends HTMLElement {
  connectedCallback() {
    this._tasks = [];
    this._filter = "all";
    this._expandedTaskIds = new Set();
    this._pollInterval = null;
    this._lastJson = null;
    this._hasLoadedOnce = false;

    this._render();
    this._cleanupResizablePanel = setupResizablePanel(this, {
      storageKey: "pi-studio-runtime-panel-width",
      defaultWidth: 360,
      minWidth: 280,
      maxWidth: 560,
    });
    this._bindCollapseToggle();
    this._startPolling();
  }

  disconnectedCallback() {
    clearInterval(this._pollInterval);
    clearTimeout(this._retryTimer);
    this._cleanupResizablePanel?.();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _render() {
    this.innerHTML = `
      <div class="runtime-header app-side-panel-header" id="runtime-header">
        <span class="runtime-title">Runtime</span>
        <button class="icon-btn app-side-panel-close-btn" data-collapse-btn title="Close" aria-label="Close runtime panel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="runtime-filters" data-filters>
        <button class="runtime-filter active" data-filter="all">All</button>
        <button class="runtime-filter" data-filter="pending">Pending <span data-pending-count>0</span></button>
        <button class="runtime-filter" data-filter="running">Running <span data-running-count>0</span></button>
        <button class="runtime-filter" data-filter="done">Done <span data-done-count>0</span></button>
      </div>
      <div class="runtime-task-list" data-task-list></div>
    `;

    // Restore collapsed state
    if (localStorage.getItem("sa-runtime-collapsed") === "1") {
      this.classList.add("collapsed");
    }

    this.querySelector("[data-filters]").addEventListener("click", (e) => {
      const btn = e.target.closest(".runtime-filter");
      if (!btn) return;
      this._filter = btn.dataset.filter;
      this.querySelectorAll(".runtime-filter").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      this._renderTasks();
    });
  }

  _bindCollapseToggle() {
    const toggle = () => {
      const collapsed = this.classList.toggle("collapsed");
      localStorage.setItem("sa-runtime-collapsed", collapsed ? "1" : "0");
    };
    this.querySelector("[data-collapse-btn]")?.addEventListener(
      "click",
      toggle,
    );
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._retryDelay = 400;
    this._poll();
    this._pollInterval = setInterval(() => this._poll(), 3000);
  }

  async _poll() {
    try {
      const res = await fetch("/api/super-agent/tasks");
      if (!res.ok) {
        this._scheduleRetry();
        return;
      }
      const json = await res.text();
      this._hasLoadedOnce = true;
      this._retryDelay = 400;
      if (json === this._lastJson) return;
      this._lastJson = json;
      this._tasks = JSON.parse(json).tasks || [];
      this._renderAll();
    } catch {
      this._scheduleRetry();
    }
  }

  // The embedded pi server can still be warming up its extension routes
  // right after a fresh workspace/session spawn even though /api/health
  // already answered (see wait_for_endpoint in pi_manager.rs). Rather than
  // waiting out the full 3s interval on a failed/errored first poll, retry
  // quickly with backoff until we've loaded successfully once.
  _scheduleRetry() {
    if (this._hasLoadedOnce) return;
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._poll(), this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, 3000);
  }

  async _save() {
    await fetch("/api/super-agent/tasks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: this._tasks }),
    });
    this._lastJson = null;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async _approve(taskId) {
    const task = this._tasks.find((t) => t.id === taskId);
    if (!task || !isDispatchableProjectPath(task.targetProject)) return;
    task.status = "running";
    task.failReason = null;
    await this._save();
    this._renderAll();
    this.dispatchEvent(
      new CustomEvent("sa-dispatch", { detail: task, bubbles: true }),
    );
  }

  async _dismiss(taskId) {
    this._tasks = this._tasks.filter((t) => t.id !== taskId);
    await this._save();
    this._renderAll();
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  _renderAll() {
    const pending = this._tasks.filter((t) => t.status === "pending").length;
    const running = this._tasks.filter((t) => t.status === "running").length;
    const done = this._tasks.filter((t) => t.status === "done").length;

    const q = (sel) => this.querySelector(sel);
    q("[data-pending-count]").textContent = pending;
    q("[data-running-count]").textContent = running;
    q("[data-done-count]").textContent = done;

    // Update sidebar entry badge (outside this component)
    const badge = document.getElementById("super-agent-badge");
    if (badge) {
      const urgent = pending + running;
      badge.textContent = urgent;
      badge.classList.toggle("hidden", urgent === 0);
    }

    this._renderTasks();
  }

  _renderTasks() {
    const list = this.querySelector("[data-task-list]");
    if (!list) return;

    if (!this._hasLoadedOnce) {
      list.innerHTML = `<div style="padding:20px 0;text-align:center;font-size:12px;color:var(--text-dim)">
        Connecting…
      </div>`;
      return;
    }

    const order = { pending: 0, running: 1, failed: 2, done: 3 };
    let filtered = this._tasks.filter(
      (t) => this._filter === "all" || t.status === this._filter,
    );
    filtered = [...filtered].sort(
      (a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4),
    );

    if (filtered.length === 0) {
      list.innerHTML = `<div style="padding:20px 0;text-align:center;font-size:12px;color:var(--text-dim)">
        No tasks${this._filter !== "all" ? ` with status "${this._filter}"` : ""}…
      </div>`;
      return;
    }

    list.innerHTML = filtered.map((t) => this._cardHtml(t)).join("");
    this._bindCardEvents(list);
  }

  _cardHtml(task) {
    const isExpanded = this._expandedTaskIds.has(task.id);
    const hasTargetProject = isDispatchableProjectPath(task.targetProject);
    const projectName = task.targetProject?.split("/").pop() || "";
    let body = "";

    if (isExpanded) {
      if (task.description) {
        body += `<div class="runtime-task-desc">${formatTaskDescription(task.description)}</div>`;
      }

      if (task.status === "pending") {
        if (hasTargetProject) {
          body += `<div class="runtime-task-target">Project: <strong>${esc(projectName)}</strong></div>`;
          body += `
            <div class="runtime-approve-row">
              <button class="sa-btn sa-btn-approve" data-action="approve" data-task-id="${task.id}">Approve</button>
              <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${task.id}">✕</button>
            </div>`;
        } else {
          body += `
            <div class="runtime-task-missing-target">Choose a project when creating this task.</div>
            <div class="runtime-approve-row">
              <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${task.id}">✕</button>
            </div>`;
        }
      } else if (task.status === "done" || task.status === "running") {
        if (hasTargetProject) {
          body += `<div class="runtime-task-target">Target: <strong>${esc(projectName)}</strong></div>`;
        }
      } else if (task.status === "failed") {
        body += `<div class="runtime-task-error">${esc(task.failReason || "Unknown error")}</div>`;
        if (hasTargetProject) {
          body += `<div class="runtime-task-target">Project: <strong>${esc(projectName)}</strong></div>`;
          body += `
            <div class="runtime-approve-row">
              <button class="sa-btn sa-btn-approve" data-action="retry" data-task-id="${task.id}">Retry</button>
              <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${task.id}">Dismiss</button>
            </div>`;
        } else {
          body += `
            <div class="runtime-task-missing-target">Choose a project when creating this task.</div>
            <div class="runtime-approve-row">
              <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${task.id}">Dismiss</button>
            </div>`;
        }
      }
    }

    return `<div class="runtime-task-card status-${task.status} ${isExpanded ? "is-expanded" : "is-collapsed"}"
      data-task-id="${task.id}" role="button" tabindex="0" aria-expanded="${isExpanded}">
      <div class="runtime-task-header">
        <span class="runtime-status-dot"></span>
        <span class="runtime-status-badge">${task.status.toUpperCase()}</span>
        <span class="runtime-task-title">${esc(task.title || "(untitled)")}</span>
        <span class="runtime-task-expand-icon" aria-hidden="true"></span>
      </div>
      ${body}
    </div>`;
  }

  _bindCardEvents(list) {
    list.querySelectorAll(".runtime-task-card").forEach((card) => {
      const toggle = () => {
        const { taskId } = card.dataset;
        if (this._expandedTaskIds.has(taskId)) {
          this._expandedTaskIds.delete(taskId);
        } else {
          this._expandedTaskIds.add(taskId);
        }
        this._renderTasks();
      };
      card.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, textarea, a")) return;
        toggle();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("button, input, select, textarea, a")) return;
        e.preventDefault();
        toggle();
      });
    });

    list.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const { action, taskId } = el.dataset;
        if (action === "approve" || action === "retry") {
          this._approve(taskId);
        } else if (action === "dismiss") {
          this._dismiss(taskId);
        }
      });
    });
  }
}

function isDispatchableProjectPath(path) {
  const normalized = String(path || "").replace(/\/+$/, "");
  return (
    normalized.includes("/") && !normalized.endsWith("/.pi/agent/super-agent")
  );
}

function formatTaskDescription(description) {
  const lines = normalizeTaskDescription(description);
  if (lines.length === 0) return "";

  return lines
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        return `<div class="runtime-task-section-title">${renderTaskInline(heading[1])}</div>`;
      }

      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) {
        return `<div class="runtime-task-list-item">${renderTaskInline(bullet[1])}</div>`;
      }

      const numbered = line.match(/^\d+\.\s+(.+)$/);
      if (numbered) {
        return `<div class="runtime-task-list-item">${renderTaskInline(numbered[1])}</div>`;
      }

      return `<div class="runtime-task-paragraph">${renderTaskInline(line)}</div>`;
    })
    .join("");
}

function normalizeTaskDescription(description) {
  return String(description ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+(#{1,6})\s+/g, "\n$1 ")
    .replace(
      /[ \t]+[-*]\s+(?=(?:\p{Extended_Pictographic}|\*\*|[A-Z0-9]))/gu,
      "\n- ",
    )
    .replace(/[ \t]+(\d+)\.\s+/g, "\n$1. ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderTaskInline(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

customElements.define("super-agent-runtime", SuperAgentRuntime);
