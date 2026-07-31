import { getTransport } from "../app/transport.js";
import { t } from "../i18n/index.js";
import { presentWorkState } from "./work-status.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function attribution(value) {
  const labels = {
    processOwned: t("runtime.attribution.processOwned", {}, "Process-owned"),
    shared: t("runtime.attribution.shared", {}, "Shared"),
    estimated: t("runtime.attribution.estimated", {}, "Estimated"),
    providerReported: t("runtime.attribution.providerReported", {}, "Provider-reported"),
    unavailable: t("runtime.attribution.unavailable", {}, "Unavailable"),
  };
  return labels[value] || labels.unavailable;
}

function stateLabel(state) {
  const presentation = presentWorkState(state);
  return t(presentation.labelKey, {}, presentation.fallbackLabel);
}

function statePhase(state) {
  return presentWorkState(state).phase;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function usageValue(field) {
  return field?.value == null ? attribution("unavailable") : String(field.value);
}

export class PicodeRuntimeMonitor extends HTMLElement {
  connectedCallback() {
    this._snapshot = { execution: { tasks: [] }, agentRuns: [] };
    this._render();
    this._onLocaleChanged = () => this._render();
    window.addEventListener("picot:locale-changed", this._onLocaleChanged);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    window.removeEventListener("picot:locale-changed", this._onLocaleChanged);
  }

  get transport() {
    return this._transport || getTransport();
  }

  set transport(value) {
    this._transport = value;
  }

  async open() {
    this.setAttribute("open", "");
    await this.refresh();
    clearInterval(this._timer);
    this._timer = setInterval(() => this.refresh(), 3000);
  }

  close() {
    this.removeAttribute("open");
    clearInterval(this._timer);
    this._timer = null;
  }

  async refresh() {
    if (!this.transport) return;
    try {
      const [snapshot, toolRuntimes] = await Promise.all([
        this.transport.taskSnapshot(),
        this._fetchToolRuntimes(),
      ]);
      this._snapshot = { ...snapshot, toolRuntimes };
      this._error = "";
    } catch (error) {
      this._error = error?.message || String(error);
    }
    this._render();
  }

  async _fetchToolRuntimes(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") return null;
    try {
      const response = await fetchImpl("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_picode_runtime_snapshot" }),
      });
      const payload = await response.json();
      return payload?.success ? payload.data : null;
    } catch {
      return null;
    }
  }

  _render() {
    const tasks = new Map((this._snapshot?.execution?.tasks || []).map((task) => [task.id, task]));
    const runs = this._snapshot?.agentRuns || [];
    const jobs = this._snapshot?.orchestration?.jobs || [];
    const routingDecisions = this._snapshot?.orchestration?.routingDecisions || [];
    const extensionRuns = this._snapshot?.extensions?.runs || [];
    const mcpRuns = this._snapshot?.extensions?.mcpRuns || [];
    const dapSessions = this._snapshot?.extensions?.dapSessions || [];
    const toolRuntime = this._snapshot?.toolRuntimes;
    const piSubagents = toolRuntime?.piSubagents || [];
    const toolRuntimes = toolRuntime
      ? [
          { id: "shell", label: "Shell", count: toolRuntime.shellSessions },
          { id: "javascript", label: "JavaScript Eval", count: toolRuntime.javascriptKernels },
          { id: "python", label: "Python Eval", count: toolRuntime.pythonKernels },
          { id: "browser", label: "Browser tabs", count: toolRuntime.tabs },
        ].filter((runtime) => Number(runtime.count) > 0)
      : [];
    const roots = runs.filter((run) => !run.parentId);
    const ordered = [];
    const append = (run, depth = 0) => {
      ordered.push({ run, depth });
      for (const child of runs.filter((candidate) => candidate.parentId === run.id)) {
        append(child, depth + 1);
      }
    };
    for (const run of roots) append(run);
    for (const run of runs) {
      if (!ordered.some((entry) => entry.run.id === run.id)) append(run);
    }
    this.innerHTML = `
      <div class="picode-runtime-monitor__backdrop" data-runtime-close></div>
      <aside class="picode-runtime-monitor__drawer" aria-label="${escapeHtml(t("runtime.title", {}, "Activity & verification"))}">
        <header>
          <div><span class="picode-eyebrow">ACTIVITY</span><h2>${escapeHtml(t("runtime.title", {}, "Activity & verification"))}</h2></div>
          <button class="picode-icon-button" data-runtime-close aria-label="${escapeHtml(t("common.close", {}, "Close"))}">×</button>
        </header>
        <div class="picode-runtime-summary">
          <div><strong>${runs.filter((run) => !["completed", "failed", "cancelled", "terminated"].includes(run.state)).length + jobs.filter((job) => job.status === "running").length + extensionRuns.filter((run) => run.state === "running").length + mcpRuns.filter((run) => run.state === "running").length + dapSessions.filter((run) => run.state === "running").length + piSubagents.filter((run) => run.state === "running").length + toolRuntimes.reduce((total, runtime) => total + Number(runtime.count || 0), 0)}</strong><span>${escapeHtml(t("runtime.active", {}, "Active"))}</span></div>
          <div><strong>${runs.length + jobs.length + extensionRuns.length + mcpRuns.length + dapSessions.length + piSubagents.length + toolRuntimes.reduce((total, runtime) => total + Number(runtime.count || 0), 0)}</strong><span>${escapeHtml(t("runtime.total", {}, "Recent runs"))}</span></div>
        </div>
        <div class="picode-runtime-list">
          ${this._error ? `<p class="picode-runtime-error">${escapeHtml(this._error)}</p>` : ""}
          ${ordered.length ? ordered.map(({ run, depth }) => this._runCard(run, tasks.get(run.taskId), depth)).join("") : `<div class="picode-runtime-empty">${escapeHtml(t("runtime.empty", {}, "No Agent Runs yet."))}</div>`}
          ${jobs.length ? `<h3 class="picode-runtime-section-title">${escapeHtml(t("runtime.backgroundJobs", {}, "Background jobs"))}</h3>${jobs.map((job) => this._jobCard(job, tasks.get(job.taskId))).join("")}` : ""}
          ${piSubagents.length ? `<h3 class="picode-runtime-section-title">${escapeHtml(t("runtime.piSubagents", {}, "Pi subagents"))}</h3>${piSubagents.map((run) => this._piSubagentCard(run)).join("")}` : ""}
          ${toolRuntimes.length ? `<h3 class="picode-runtime-section-title">${escapeHtml(t("runtime.toolRuntimes", {}, "Agent tool runtimes"))}</h3>${toolRuntimes.map((runtime) => this._toolRuntimeCard(runtime, toolRuntime)).join("")}` : ""}
          ${extensionRuns.length || mcpRuns.length || dapSessions.length ? `<h3 class="picode-runtime-section-title">${escapeHtml(t("runtime.professional", {}, "Professional extensions"))}</h3>${extensionRuns.map((run) => this._extensionCard(run, "EXT")).join("")}${mcpRuns.map((run) => this._scopedProcessCard(run, "MCP")).join("")}${dapSessions.map((run) => this._scopedProcessCard({ ...run, ownerId: run.target }, "DAP")).join("")}` : ""}
          ${
            routingDecisions.length
              ? `<h3 class="picode-runtime-section-title">${escapeHtml(t("runtime.routing", {}, "Model routing"))}</h3>${routingDecisions
                  .slice(-8)
                  .reverse()
                  .map(
                    (record) =>
                      `<article class="picode-routing-record"><strong>${escapeHtml(record.class)}</strong><span>${escapeHtml(record.decision?.modelId || "—")}</span><small>${escapeHtml(record.decision?.reason || "")}</small></article>`,
                  )
                  .join("")}`
              : ""
          }
        </div>
      </aside>`;
    for (const close of this.querySelectorAll("[data-runtime-close]")) {
      close.addEventListener("click", () => this.close());
    }
    for (const button of this.querySelectorAll("[data-cancel-run]")) {
      button.addEventListener("click", async () => {
        await this.transport.cancelAgentRun(button.dataset.cancelRun);
        await this.refresh();
      });
    }
    for (const button of this.querySelectorAll("[data-cancel-job]")) {
      button.addEventListener("click", async () => {
        await this.transport.cancelBackgroundJob(button.dataset.cancelJob);
        await this.refresh();
      });
    }
    for (const button of this.querySelectorAll("[data-cancel-extension]")) {
      button.addEventListener("click", async () => {
        await this.transport.cancelProfessionalExtension(button.dataset.cancelExtension);
        await this.refresh();
      });
    }
    for (const button of this.querySelectorAll("[data-open-chat]")) {
      button.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("picode-open-chat", {
            bubbles: true,
            detail: { chatId: button.dataset.openChat },
          }),
        );
      });
    }
  }

  _runCard(run, task, depth) {
    const sample = run.samples?.at(-1);
    const terminal = ["completed", "failed", "cancelled", "terminated"].includes(run.state);
    return `<article class="picode-agent-run ${depth ? "is-child" : ""}" data-agent-run="${escapeHtml(run.id)}" ${run.parentId ? `data-parent-run="${escapeHtml(run.parentId)}"` : ""} style="--agent-depth:${depth}">
      <div class="picode-agent-run__head">
        <span class="picode-agent-avatar">${depth ? "S" : "P"}</span>
        <div><strong>${escapeHtml(task?.goal || run.taskId)}</strong><small>${escapeHtml(run.provider)} · ${escapeHtml(run.model)}</small></div>
        <span class="picode-agent-state" data-state="${escapeHtml(statePhase(run.state))}" title="${escapeHtml(t(`runtime.state.${run.state}`, {}, run.state || "unknown"))}">${escapeHtml(stateLabel(run.state))}</span>
      </div>
      <p class="picode-agent-action">${escapeHtml(run.currentAction || "—")}</p>
      <dl class="picode-agent-metrics">
        <div><dt>CPU</dt><dd>${sample ? `${Number(sample.cpuPercent || 0).toFixed(1)}%` : "—"}</dd></div>
        <div><dt>${escapeHtml(t("runtime.memory", {}, "Memory"))}</dt><dd>${sample ? formatBytes(sample.memoryBytes) : "—"}</dd></div>
        <div><dt>${escapeHtml(t("runtime.tokens", {}, "Tokens"))}</dt><dd>${usageValue(run.usage?.inputTokens)}</dd></div>
        <div><dt>${escapeHtml(t("runtime.attribution", {}, "Attribution"))}</dt><dd>${escapeHtml(attribution(sample?.attribution || run.usage?.inputTokens?.attribution || "unavailable"))}</dd></div>
      </dl>
      <details class="picode-work-details"><summary>${escapeHtml(t("runtime.details", {}, "Run details"))}</summary><div class="picode-agent-run__identity"><code>${escapeHtml(run.id)}</code><span>PID ${escapeHtml(run.processId)}</span><span>${escapeHtml(run.accountId)}</span><span>${escapeHtml(usageValue(run.usage?.costMicros))}</span><span>${escapeHtml(t(`runtime.state.${run.state}`, {}, run.state || "unknown"))}</span></div></details>
      <div class="picode-agent-run__actions">
        <button class="picode-button picode-button--secondary" data-open-chat="${escapeHtml(run.chatId)}">${escapeHtml(t("runtime.openChat", {}, "Open chat"))}</button>
        ${terminal ? "" : `<button class="picode-button picode-button--danger" data-cancel-run="${escapeHtml(run.id)}">${escapeHtml(t("runtime.cancelRun", {}, "Cancel run"))}</button>`}
      </div>
    </article>`;
  }

  _jobCard(job, task) {
    const terminal = ["completed", "failed", "cancelled", "timedOut", "terminated"].includes(
      job.status,
    );
    return `<article class="picode-background-job" data-background-job="${escapeHtml(job.id)}">
      <div class="picode-agent-run__head">
        <span class="picode-agent-avatar">J</span>
        <div><strong>${escapeHtml(task?.goal || job.taskId)}</strong><small>${escapeHtml(job.command)}</small></div>
        <span class="picode-agent-state" data-state="${escapeHtml(statePhase(job.status))}" title="${escapeHtml(t(`runtime.state.${job.status}`, {}, job.status || "unknown"))}">${escapeHtml(stateLabel(job.status))}</span>
      </div>
      <details class="picode-work-details"><summary>${escapeHtml(t("runtime.details", {}, "Run details"))}</summary><div class="picode-agent-run__identity"><code>${escapeHtml(job.id)}</code><span>PID ${escapeHtml(job.processId)}</span><span>${escapeHtml(job.fullOutputHash || "—")}</span></div></details>
      ${terminal ? "" : `<div class="picode-agent-run__actions"><button class="picode-button picode-button--danger" data-cancel-job="${escapeHtml(job.id)}">${escapeHtml(t("runtime.cancelJob", {}, "Cancel job"))}</button></div>`}
    </article>`;
  }

  _toolRuntimeCard(runtime, snapshot) {
    return `<article class="picode-background-job" data-tool-runtime="${escapeHtml(runtime.id)}">
      <div class="picode-agent-run__head">
        <span class="picode-agent-avatar">T</span>
        <div><strong>${escapeHtml(runtime.label)}</strong><small>${escapeHtml(t("runtime.lazyRuntime", {}, "Lazy task runtime"))}</small></div>
        <span class="picode-agent-state" data-state="working">${escapeHtml(stateLabel("running"))}</span>
      </div>
      <details class="picode-work-details"><summary>${escapeHtml(t("runtime.details", {}, "Run details"))}</summary><div class="picode-agent-run__identity"><code>${escapeHtml(runtime.count)}</code><span>PID ${escapeHtml(snapshot.processId)}</span><span>${formatBytes(snapshot.memoryBytes)}</span><span>${escapeHtml(attribution("shared"))}</span></div></details>
    </article>`;
  }

  _piSubagentCard(run) {
    const label = run.goal || run.task || run.agent || run.id;
    const agents = run.agents?.length ? run.agents.join(" → ") : run.agent || "subagent";
    return `<article class="picode-background-job" data-pi-subagent="${escapeHtml(run.id)}">
      <div class="picode-agent-run__head">
        <span class="picode-agent-avatar">S</span>
        <div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(agents)} · ${escapeHtml(run.mode || "single")}</small></div>
        <span class="picode-agent-state" data-state="${escapeHtml(statePhase(run.state))}">${escapeHtml(stateLabel(run.state))}</span>
      </div>
      ${run.summary ? `<p class="picode-agent-action">${escapeHtml(run.summary)}</p>` : ""}
      <details class="picode-work-details"><summary>${escapeHtml(t("runtime.details", {}, "Run details"))}</summary><div class="picode-agent-run__identity"><code>${escapeHtml(run.id)}</code><span>${run.processId ? `PID ${escapeHtml(run.processId)}` : "PID —"}</span><span>${escapeHtml(t("runtime.piSubagentManaged", {}, "Manage with /subagents"))}</span></div></details>
    </article>`;
  }

  _extensionCard(run, glyph) {
    const terminal = [
      "completed",
      "failed",
      "cancelled",
      "timedOut",
      "terminated",
      "resourceStopped",
    ].includes(run.state);
    return `<article class="picode-background-job" data-extension-run="${escapeHtml(run.id)}">
      <div class="picode-agent-run__head"><span class="picode-agent-avatar">${glyph}</span><div><strong>${escapeHtml(run.extensionId)}</strong><small>${escapeHtml(run.taskId)} · ${formatBytes(run.observedMemoryBytes || 0)}</small></div><span class="picode-agent-state" data-state="${escapeHtml(statePhase(run.state))}">${escapeHtml(stateLabel(run.state))}</span></div>
      <details class="picode-work-details"><summary>${escapeHtml(t("runtime.details", {}, "Run details"))}</summary><div class="picode-agent-run__identity"><code>${escapeHtml(run.id)}</code><span>PID ${escapeHtml(run.processId)}</span><span>${escapeHtml(run.fullOutputHash || "—")}</span></div></details>
      ${terminal ? "" : `<div class="picode-agent-run__actions"><button class="picode-button picode-button--danger" data-cancel-extension="${escapeHtml(run.id)}">${escapeHtml(t("runtime.cancelExtension", {}, "Cancel extension"))}</button></div>`}
    </article>`;
  }

  _scopedProcessCard(run, glyph) {
    return `<article class="picode-background-job" data-scoped-process="${escapeHtml(run.id)}">
      <div class="picode-agent-run__head"><span class="picode-agent-avatar">${glyph}</span><div><strong>${escapeHtml(run.ownerId || run.target || glyph)}</strong><small>${escapeHtml(run.taskId)}</small></div><span class="picode-agent-state" data-state="${escapeHtml(statePhase(run.state))}">${escapeHtml(stateLabel(run.state))}</span></div>
      <details class="picode-work-details"><summary>${escapeHtml(t("runtime.details", {}, "Run details"))}</summary><div class="picode-agent-run__identity"><code>${escapeHtml(run.id)}</code><span>${run.processId ? `PID ${escapeHtml(run.processId)}` : "client transport"}</span></div></details>
    </article>`;
  }
}

if (!customElements.get("picode-runtime-monitor")) {
  customElements.define("picode-runtime-monitor", PicodeRuntimeMonitor);
}
