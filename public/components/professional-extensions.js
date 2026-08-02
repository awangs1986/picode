import { getTransport } from "../app/transport.js";
import { t } from "../i18n/index.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatPermission(value) {
  return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function canonicalSkillBundleSource(source) {
  const raw = String(source || "").trim();
  const lower = raw.toLowerCase();
  if (!raw || ["unknown", "runtime", "top-level"].includes(lower)) return "";

  if (lower.startsWith("npm:")) {
    const packageSpec = raw.slice(4);
    const versionSeparator = packageSpec.lastIndexOf("@");
    const packageName = versionSeparator > 0 ? packageSpec.slice(0, versionSeparator) : packageSpec;
    return packageName ? `npm:${packageName.toLowerCase()}` : "";
  }

  if (!/^(?:git:|git\+|https?:\/\/|github\.com\/)/i.test(raw)) return "";
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/#.*$/, "")
    .replace(/\.git(?=@[^/]+$|$)/, "")
    .replace(/@[^/]+$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function skillBundleLabel(source) {
  const normalized = canonicalSkillBundleSource(source)
    .replace(/^npm:/, "")
    .replace(/^github\.com\//, "");
  return normalized || t("professional.individualSkill", {}, "Individual skill");
}

export function groupInstalledSkills(skills) {
  const groups = new Map();
  for (const [index, skill] of (skills || []).entries()) {
    const source = String(skill?.source || "");
    const bundleSource = canonicalSkillBundleSource(source);
    const bundled = Boolean(bundleSource);
    const key = bundled ? `bundle:${bundleSource}` : `skill:${index}:${skill?.name || "unknown"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        bundled,
        label: bundled ? skillBundleLabel(source) : skill?.name || "skill",
        source: bundleSource || source,
        skills: [],
      });
    }
    groups.get(key).skills.push(skill);
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function groupExtensionComponents(components) {
  const groups = new Map();
  for (const [index, component] of (components || []).entries()) {
    const bundleSource =
      component?.kind === "skill" ? canonicalSkillBundleSource(component.source) : "";
    const bundled = Boolean(bundleSource);
    const key = bundled ? `skill-bundle:${bundleSource}` : `component:${index}:${component?.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        bundled,
        source: bundleSource,
        label: bundled ? skillBundleLabel(component.source) : component?.id || "component",
        components: [],
      });
    }
    groups.get(key).components.push(component);
  }
  return [...groups.values()];
}

export class PicodeProfessionalExtensions extends HTMLElement {
  connectedCallback() {
    this._snapshot ||= null;
    this._herdrStatus ||= null;
    this._capabilitySnapshot ||= null;
    this._effectiveReport ||= null;
    this._effectiveTask ||= "";
    this._importPreview ||= null;
    this._mcpPreview ||= null;
    this._selectedImports ||= new Set();
    this._selectedMcp ||= new Set();
    this._importRoot ||= "";
    this._busy ||= false;
    this._render();
    this.refresh();
  }

  get transport() {
    return this._transport || getTransport();
  }

  set transport(value) {
    this._transport = value;
  }

  async refresh() {
    const errors = [];

    if (this.transport.listSkills && this.transport.syncExtensionSkills) {
      await Promise.resolve()
        .then(() => this.transport.listSkills())
        .then((skills) => this.transport.syncExtensionSkills(skills))
        .catch((error) => errors.push(error));
    }

    const extensionSnapshot = this.transport.extensionSnapshot
      ? await Promise.resolve()
          .then(() => this.transport.extensionSnapshot())
          .catch((error) => {
            errors.push(error);
            return null;
          })
      : null;
    if (extensionSnapshot) this._snapshot = extensionSnapshot;

    const herdrStatus = this.transport.herdrStatus
      ? await Promise.resolve()
          .then(() => this.transport.herdrStatus())
          .catch((error) => {
            errors.push(error);
            return null;
          })
      : null;
    if (herdrStatus) this._herdrStatus = herdrStatus;

    const capabilitySnapshot = this.transport.capabilitySnapshot
      ? await Promise.resolve()
          .then(() => this.transport.capabilitySnapshot())
          .catch((error) => {
            errors.push(error);
            return null;
          })
      : null;
    if (capabilitySnapshot) this._capabilitySnapshot = capabilitySnapshot;

    this._error = errors.length
      ? errors.map((error) => error?.message || String(error)).join("; ")
      : "";
    this._render();
  }

  _scope() {
    const kind = this.querySelector("[data-extension-scope]")?.value || "global";
    if (kind === "global") return "global";
    const taskId = this.querySelector("[data-extension-task]")?.value.trim();
    if (!taskId) throw new Error(t("professional.taskRequired", {}, "Enter a Task ID."));
    return { task: taskId };
  }

  _render() {
    const snapshot = this._snapshot || {};
    const installations = snapshot.installations || [];
    const imports = snapshot.imports || [];
    const mcp = snapshot.mcpConfigs || [];
    const capabilities = this._capabilitySnapshot?.capabilities || [];
    const skills = snapshot.skills || [];
    const firstmate = snapshot.firstmate || {};
    const skillGroups = groupInstalledSkills(skills);
    const components = snapshot.components || [];
    const componentGroups = groupExtensionComponents(components);
    const residents = Number(snapshot.residentProcessCount || 0);
    this.innerHTML = `
      <div class="picode-professional-head">
        <div><div class="settings-section-title">${escapeHtml(t("professional.title", {}, "Professional extensions"))}</div>
        <p class="settings-help">${escapeHtml(t("professional.help", {}, "Heavy tools stay stopped until you explicitly enable and start them."))}</p></div>
        <span class="picode-resident-badge" data-resident-count="${residents}">${residents} ${escapeHtml(t("professional.residents", {}, "resident processes"))}</span>
      </div>
      ${this._error ? `<p class="picode-runtime-error">${escapeHtml(this._error)}</p>` : ""}
      <div class="picode-professional-grid">
        <section class="picode-professional-card picode-professional-card--wide">
          <header><div><span class="picode-eyebrow">RUNTIME</span><h3>${escapeHtml(t("professional.componentStatus", {}, "Extension component status"))}</h3></div><small>${componentGroups.length}</small></header>
          <p class="settings-help">${escapeHtml(t("professional.componentStatusHelp", {}, "Authoritative state from Extension Manager, including source, version, permissions, task bindings, running processes, and the latest error."))}</p>
          ${components.length ? `<div class="picode-imported-list">${componentGroups.map((group) => this._componentGroup(group)).join("")}</div>` : `<p class="picode-runtime-empty">${escapeHtml(t("professional.noComponents", {}, "No extension components discovered."))}</p>`}
        </section>
        <section class="picode-professional-card picode-professional-card--wide">
          <header><div><span class="picode-eyebrow">SKILLS</span><h3>${escapeHtml(t("professional.skills", {}, "Installed skills"))}</h3></div><small>${this._snapshot === null ? "—" : skills.length}</small></header>
          <p class="settings-help">${escapeHtml(t("professional.skillsHelp", {}, "Skills discovered by the current Pi runtime are synchronized into Extension Manager before they are shown here."))}</p>
          ${this._snapshot === null ? `<p class="picode-runtime-empty">${escapeHtml(t("professional.skillsLoading", {}, "Loading skills…"))}</p>` : skills.length ? `<div class="picode-imported-list">${skillGroups.map((group) => this._skillGroup(group)).join("")}</div>` : `<p class="picode-runtime-empty">${escapeHtml(t("professional.noSkills", {}, "No skills are currently loaded."))}</p>`}
        </section>
        ${`<section class="picode-professional-card picode-professional-card--wide">
          <header><div><span class="picode-eyebrow">CAPABILITIES</span><h3>${escapeHtml(t("professional.capabilities", {}, "Optional capabilities"))}</h3></div><small>${capabilities.length}</small></header>
          <p class="settings-help">${escapeHtml(t("professional.capabilitiesHelp", {}, "Disabled modules stay out of the Agent catalog and consume no process resources."))}</p>
          ${capabilities.length ? `<div class="picode-imported-list">${capabilities.map((item) => this._capabilityRow(item, firstmate)).join("")}</div>` : `<p class="picode-runtime-empty">${escapeHtml(t("professional.noCapabilities", {}, "No optional capabilities are available."))}</p>`}
        </section>`}
        <section class="picode-professional-card picode-professional-card--wide">
          <header><div><span class="picode-eyebrow">DIAGNOSTICS</span><h3>${escapeHtml(t("professional.effectiveTitle", {}, "Effective task configuration"))}</h3></div></header>
          <p class="settings-help">${escapeHtml(t("professional.effectiveHelp", {}, "Read-only view of what the model can actually see and invoke for one task."))}</p>
          <div class="picode-professional-controls"><input class="ui-input" data-effective-task value="${escapeHtml(this._effectiveTask)}" placeholder="Task ID"><button type="button" class="ui-button ui-button--secondary" data-effective-report>${escapeHtml(t("professional.inspectEffective", {}, "Inspect"))}</button></div>
          <div data-effective-output>${this._renderEffectiveReport()}</div>
        </section>
        <section class="picode-professional-card">
          <header><div><span class="picode-eyebrow">HOST</span><h3>${escapeHtml(t("professional.installed", {}, "Isolated host"))}</h3></div><small>${installations.length}</small></header>
          ${installations.length ? installations.map((item) => this._extensionRow(item)).join("") : `<p class="picode-runtime-empty">${escapeHtml(t("professional.noneInstalled", {}, "No heavy extensions installed."))}</p>`}
          <details class="picode-professional-details"><summary>${escapeHtml(t("professional.installManifest", {}, "Install reviewed executable"))}</summary>
            <div class="picode-manifest-form"><input class="ui-input" data-manifest-id placeholder="extension-id"><input class="ui-input" data-manifest-executable placeholder="C:\\tools\\extension.exe"><textarea data-manifest-args rows="2" placeholder="one argument per line"></textarea><label><input type="checkbox" data-manifest-read checked>workspaceRead</label><label><input type="checkbox" data-manifest-process checked>processExecute</label><label><input type="checkbox" data-manifest-network>network</label><button type="button" class="ui-button ui-button--secondary" data-install-extension>${escapeHtml(t("professional.install", {}, "Install disabled"))}</button></div>
          </details>
        </section>
        <section class="picode-professional-card">
          <header><div><span class="picode-eyebrow">IMPORT</span><h3>${escapeHtml(t("professional.importTitle", {}, "Rules, Skills & commands"))}</h3></div><small>${imports.length}</small></header>
          <div class="picode-professional-controls">
            <select class="ui-select" data-import-source aria-label="${escapeHtml(t("professional.source", {}, "Source"))}">
              <option value="codex">Codex</option><option value="claude">Claude</option><option value="cursor">Cursor</option><option value="openCode">OpenCode</option>
            </select>
            <button type="button" class="ui-button ui-button--secondary" data-pick-import-root>${escapeHtml(t("professional.chooseFolder", {}, "Choose folder"))}</button>
            <code data-import-root>${escapeHtml(this._importRoot || t("professional.noFolder", {}, "No folder selected"))}</code>
            <button type="button" class="ui-button ui-button--secondary" data-preview-import ${this._importRoot && !this._busy ? "" : "disabled"}>${escapeHtml(t("professional.preview", {}, "Preview"))}</button>
          </div>
          ${this._renderImportPreview()}
          ${imports.length ? `<div class="picode-imported-list">${imports.map((item) => `<div class="picode-import-candidate"><span><strong>${escapeHtml(item.sourcePath)}</strong><small>${escapeHtml(item.kind)} · ${escapeHtml(item.version)}</small></span><button type="button" class="ui-button ui-button--secondary" data-activate-import="${escapeHtml(item.id)}">${escapeHtml(t("professional.activate", {}, "Use in task"))}</button></div>`).join("")}</div>` : ""}
        </section>
        <section class="picode-professional-card picode-professional-card--wide">
          <header><div><span class="picode-eyebrow">MCP</span><h3>${escapeHtml(t("professional.mcpTitle", {}, "MCP configuration"))}</h3></div><small>${mcp.length}</small></header>
          <p class="settings-help">${escapeHtml(t("professional.mcpHelp", {}, "Paste JSON to preview it. Secret values are discarded; each environment field must be replaced with a reference."))}</p>
          <textarea class="picode-professional-json" data-mcp-json rows="5" spellcheck="false" placeholder='{"mcpServers":{}}'></textarea>
          <button type="button" class="ui-button ui-button--secondary" data-preview-mcp>${escapeHtml(t("professional.previewMcp", {}, "Preview MCP JSON"))}</button>
          ${this._renderMcpPreview()}
          ${mcp.length ? `<div class="picode-imported-list">${mcp.map((item) => `<div class="picode-import-candidate"><span><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.transport)} · ${escapeHtml(item.scope === "global" ? "global" : item.scope?.task || "task")}</small></span><label><small>${escapeHtml(t("professional.enabled", {}, "Enabled"))}</small><input type="checkbox" data-mcp-enable="${escapeHtml(item.id)}" ${item.enabled ? "checked" : ""}></label><label><small>${escapeHtml(t("professional.trusted", {}, "Trusted"))}</small><input type="checkbox" data-mcp-trust="${escapeHtml(item.id)}" ${item.trusted ? "checked" : ""} ${item.enabled ? "" : "disabled"}></label><button type="button" class="ui-button ui-button--secondary" data-activate-mcp="${escapeHtml(item.id)}" ${item.enabled && item.trusted ? "" : "disabled"}>${escapeHtml(t("professional.activateMcp", {}, "Enable for task"))}</button></div>`).join("")}</div>` : ""}
        </section>
        <section class="picode-professional-card picode-professional-card--wide">
          <header><div><span class="picode-eyebrow">DAP</span><h3>${escapeHtml(t("professional.dapTitle", {}, "Optional debugger"))}</h3></div><small>${(snapshot.dapSessions || []).length}</small></header>
          <p class="settings-help">${escapeHtml(t("professional.dapHelp", {}, "DAP never starts automatically. Launch or attach requires a Harness Task, active Agent Run, and explicit confirmation."))}</p>
          <div class="picode-dap-form"><input class="ui-input" data-dap-adapter placeholder="debug-adapter executable"><input class="ui-input" data-dap-target placeholder="target"><textarea data-dap-args rows="2" placeholder="one adapter argument per line"></textarea><select class="ui-select" data-dap-request><option value="launch">launch</option><option value="attach">attach</option></select><label><input type="checkbox" data-dap-authorize>${escapeHtml(t("professional.dapAuthorize", {}, "I explicitly authorize this debugger process"))}</label><button type="button" class="ui-button ui-button--secondary" data-launch-dap>${escapeHtml(t("professional.dapLaunch", {}, "Launch debugger"))}</button></div>
        </section>
      </div>
      <div class="picode-professional-scope">
        <label><span>${escapeHtml(t("professional.scope", {}, "Import scope"))}</span><select class="ui-select" data-extension-scope><option value="global">${escapeHtml(t("professional.global", {}, "Global"))}</option><option value="task">${escapeHtml(t("professional.task", {}, "Task"))}</option></select></label>
        <label><span>${escapeHtml(t("professional.taskId", {}, "Task ID"))}</span><input class="ui-input" data-extension-task disabled></label>
        <span role="status" data-professional-status>${escapeHtml(this._status || "")}</span>
      </div>`;
    this._bind();
  }

  _extensionRow(item) {
    const permissions = (item.permissions || []).map(formatPermission).join(" · ");
    const lifecycle = (this._snapshot?.lifecycle || []).find((entry) => entry.id === item.id);
    const trusted = lifecycle?.state === "trusted" || lifecycle?.state === "running";
    const state = lifecycle?.state || (item.enabled ? "enabled" : "discovered");
    return `<div class="picode-extension-install" data-extension="${escapeHtml(item.id)}">
      <span><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(state)} · schema ${escapeHtml(item.schemaVersion)} · ${escapeHtml(permissions || "no permissions")}</small></span>
      <label><small>${escapeHtml(t("professional.enabled", {}, "Enabled"))}</small><input type="checkbox" data-extension-enable="${escapeHtml(item.id)}" ${item.enabled ? "checked" : ""}></label>
      <label><small>${escapeHtml(t("professional.trusted", {}, "Trusted"))}</small><input type="checkbox" data-extension-trust="${escapeHtml(item.id)}" ${trusted ? "checked" : ""} ${item.enabled ? "" : "disabled"}></label>
    </div>`;
  }

  _componentRow(item) {
    const processText = (item.runningProcesses || [])
      .map((process) => `PID ${process.processId || "—"} · ${process.kind}`)
      .join(" · ");
    const bindings = (item.taskBindings || []).join(" · ");
    const detail = [
      `${item.source || "unknown"} @ ${item.version || "unknown"}`,
      `license: ${item.license || "unknown"}`,
      (item.permissions || []).join(", ") || "no permissions",
      bindings ? `tasks: ${bindings}` : "global",
      processText || "zero processes",
      item.resourceLimits
        ? `limits: ${item.resourceLimits.maxMemoryBytes} B / ${item.resourceLimits.maxOutputBytes} B`
        : "",
      item.healthCheck ? `health: ${item.healthCheck.kind}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const managed = [
      ...(this._snapshot?.catalogComponents || []),
      ...(this._snapshot?.hooks || []),
    ].some((component) => component.id === item.id);
    const herdrManaged = item.id === "herdr-terminal-host";
    const controls = herdrManaged
      ? `<small>${escapeHtml(
          t(
            "professional.herdrManaged",
            {},
            "Optional Herdr host · first-run installation is offered by picode-tui",
          ),
        )}</small><button type="button" class="ui-button ui-button--secondary ui-button--sm" data-herdr-reset>${escapeHtml(t("professional.herdrReset", {}, "Ask again in TUI"))}</button>${this._herdrStatus?.installed ? `<button type="button" class="ui-button ui-button--secondary ui-button--sm" data-herdr-remove>${escapeHtml(t("professional.herdrRemove", {}, "Remove Herdr"))}</button>` : ""}`
      : managed
        ? `<label><small>${escapeHtml(t("professional.enabled", {}, "Enabled"))}</small><input type="checkbox" data-component-enable="${escapeHtml(item.id)}" ${item.state !== "discovered" ? "checked" : ""}></label><label><small>${escapeHtml(t("professional.trusted", {}, "Trusted"))}</small><input type="checkbox" data-component-trust="${escapeHtml(item.id)}" ${["trusted", "running"].includes(item.state) ? "checked" : ""} ${item.state === "discovered" ? "disabled" : ""}></label>`
        : "";
    return `<div class="picode-extension-install" data-component="${escapeHtml(item.id)}" data-component-kind="${escapeHtml(item.kind)}">
      <span><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.kind)} · ${escapeHtml(item.state)} · ${escapeHtml(detail)}</small>${item.lastError ? `<small class="picode-runtime-error">${escapeHtml(item.lastError)}</small>` : ""}</span>
      ${controls}
    </div>`;
  }

  _componentGroup(group) {
    if (!group.bundled) return this._componentRow(group.components[0]);
    const states = [...new Set(group.components.map((component) => component.state))];
    const state = states.length === 1 ? states[0] : "mixed";
    return `<details class="picode-skill-bundle picode-component-skill-bundle" data-component-skill-bundle="${escapeHtml(group.source)}">
      <summary><span><strong>${escapeHtml(group.label)}</strong><small>${group.components.length} ${escapeHtml(t("professional.skillCount", {}, "skills"))} · ${escapeHtml(state)}</small></span><small>${escapeHtml(t("professional.expandSkillBundle", {}, "Expand"))}</small></summary>
      <div class="picode-skill-bundle-items">${group.components.map((component) => this._componentRow(component)).join("")}</div>
    </details>`;
  }

  _renderEffectiveReport() {
    const report = this._effectiveReport;
    if (!report) return "";
    const sources = [
      ...(report.rules || []),
      ...(report.skills || []),
      ...(report.overrides || []),
    ];
    const visible = (report.capabilities || []).filter(
      (item) => item.promptVisible || item.activeForTask || item.loaded,
    );
    return `<div class="picode-imported-list">
      <div class="picode-import-candidate"><span><strong>${escapeHtml(t("professional.residentCore", {}, "Resident core"))}</strong><small>${escapeHtml((report.residentCore || []).join(" · "))}</small></span></div>
      ${visible.map((item) => `<div class="picode-import-candidate"><span><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.provenance)} · ${item.loaded ? "loaded" : item.activeForTask ? "task-bound" : "discoverable"}</small></span></div>`).join("")}
      ${sources.map((item) => `<div class="picode-import-candidate"><span><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.provenance)}</small></span></div>`).join("")}
    </div>`;
  }

  _skillGroup(group) {
    if (!group.bundled) return this._skillRow(group.skills[0]);
    return `<details class="picode-skill-bundle">
      <summary><span><strong>${escapeHtml(group.label)}</strong><small>${group.skills.length} ${escapeHtml(t("professional.skillCount", {}, "skills"))}</small></span><small>${escapeHtml(t("professional.expandSkillBundle", {}, "Expand"))}</small></summary>
      <div class="picode-skill-bundle-items">${group.skills.map((skill) => this._skillRow(skill)).join("")}</div>
    </details>`;
  }

  _skillRow(skill) {
    return `<div class="picode-skill-row"><span><strong>/${escapeHtml(skill?.name || skill?.command || "skill")}</strong><small>${escapeHtml(skill?.description || "")}</small></span><small>${escapeHtml(skill?.scope || "runtime")}</small></div>`;
  }

  _capabilityRow(item, firstmate) {
    const tier = item.tier || "discoverable";
    const disabled = tier === "disabled";
    const name = t(`professional.capability.${item.id}.name`, {}, item.id);
    const summary = t(`professional.capability.${item.id}.summary`, {}, item.summary || "");
    const tierLabel = disabled
      ? t("professional.capabilityDisabled", {}, "Disabled")
      : t("professional.capabilityDiscoverable", {}, "Discoverable");
    const planned = String(item.version || "").startsWith("planned:");
    const status = planned
      ? t("professional.capabilityPlanned", {}, "Planned; implementation not installed")
      : t("professional.capabilityAvailable", {}, "Available on demand");
    const firstmateRoot =
      item.id === "firstmate-crew-orchestrator"
        ? `<div class="picode-firstmate-root"><small>${escapeHtml(firstmate?.root ? `${t("professional.firstmateRootReady", {}, "Root ready")}: ${firstmate.root}` : t("professional.firstmateRootMissing", {}, "Choose a Firstmate directory containing AGENTS.md"))}</small><button type="button" class="ui-button ui-button--secondary ui-button--sm" data-firstmate-pick-root>${escapeHtml(t("professional.firstmateChooseRoot", {}, "Choose root"))}</button><label><input type="checkbox" data-firstmate-trust ${firstmate?.trusted ? "checked" : ""} ${firstmate?.enabled ? "" : "disabled"}>${escapeHtml(t("professional.trusted", {}, "Trusted"))}</label></div>`
        : "";
    const centrallyManaged = (this._snapshot?.catalogComponents || []).some(
      (component) => component.id === item.id,
    );
    const control = centrallyManaged
      ? `<small>${escapeHtml(t("professional.managedByExtensionManager", {}, "Managed above by Extension Manager"))}</small>`
      : `<select class="ui-select" data-capability-tier="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.id)} tier"><option value="disabled" ${disabled ? "selected" : ""}>${escapeHtml(t("professional.capabilityDisabled", {}, "Disabled"))}</option><option value="discoverable" ${tier === "discoverable" ? "selected" : ""}>${escapeHtml(t("professional.capabilityDiscoverable", {}, "Discoverable"))}</option></select>`;
    return `<label class="picode-import-candidate" data-capability="${escapeHtml(item.id)}">
      <span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(summary)} · ${escapeHtml(status)} · ${escapeHtml(tierLabel)}</small>${firstmateRoot}</span>
      ${control}
    </label>`;
  }

  _renderImportPreview() {
    if (!this._importPreview) return "";
    const rows = this._importPreview.candidates || [];
    return `<div class="picode-import-preview">
      ${rows
        .map(
          (
            item,
          ) => `<label class="picode-import-candidate ${item.unsupportedReason ? "is-unsupported" : ""}">
        <input type="checkbox" data-import-candidate="${escapeHtml(item.id)}" ${this._selectedImports.has(item.id) ? "checked" : ""} ${item.unsupportedReason ? "disabled" : ""}>
        <span><strong>${escapeHtml(item.relativePath)}</strong><small>${escapeHtml(item.kind)} · ${escapeHtml(item.unsupportedReason || item.version)}</small></span>
      </label>`,
        )
        .join("")}
      <button type="button" class="ui-button ui-button--primary" data-apply-import ${this._selectedImports.size && !this._busy ? "" : "disabled"}>${escapeHtml(t("professional.importSelected", {}, "Import selected"))}</button>
    </div>`;
  }

  _renderMcpPreview() {
    if (!this._mcpPreview) return "";
    return `<div class="picode-import-preview">
      ${(this._mcpPreview.candidates || [])
        .map(
          (
            item,
          ) => `<div class="picode-mcp-candidate ${item.unsupportedReason ? "is-unsupported" : ""}">
        <label><input type="checkbox" data-mcp-candidate="${escapeHtml(item.id)}" ${this._selectedMcp.has(item.id) ? "checked" : ""} ${item.unsupportedReason ? "disabled" : ""}><span><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.transport)} · ${escapeHtml(item.unsupportedReason || item.command || item.url || "")}</small></span></label>
        ${(item.requiredEnvironment || []).map((name) => `<label class="picode-secret-reference"><code>${escapeHtml(name)}</code><select class="ui-select" data-secret-kind="${escapeHtml(item.id)}:${escapeHtml(name)}"><option value="environment">${escapeHtml(t("professional.envRef", {}, "Environment variable"))}</option><option value="file">${escapeHtml(t("professional.fileRef", {}, "Password-file path"))}</option><option value="credential">${escapeHtml(t("professional.credentialRef", {}, "OS credential service/account"))}</option></select><input class="ui-input" data-secret-value="${escapeHtml(item.id)}:${escapeHtml(name)}" placeholder="REFERENCE_ONLY"></label>`).join("")}
      </div>`,
        )
        .join("")}
      <button type="button" class="ui-button ui-button--primary" data-apply-mcp ${this._selectedMcp.size && !this._busy ? "" : "disabled"}>${escapeHtml(t("professional.importSelectedMcp", {}, "Import selected MCP servers"))}</button>
    </div>`;
  }

  _bind() {
    this.querySelector("[data-effective-report]")?.addEventListener("click", () =>
      this._inspectEffectiveReport(),
    );
    this.querySelectorAll("[data-capability-tier]").forEach((select) => {
      select.addEventListener("change", async () => {
        try {
          await this.transport.setCapabilityTier(select.dataset.capabilityTier, select.value);
          window.dispatchEvent(
            new CustomEvent("picode:capability-tier-changed", {
              detail: { id: select.dataset.capabilityTier, tier: select.value },
            }),
          );
          await this.refresh();
        } catch (error) {
          this._error = error?.message || String(error);
          this._render();
        }
      });
    });
    this.querySelector("[data-firstmate-pick-root]")?.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        const root = await this.transport.pickFolder();
        if (root) {
          await this.transport.setFirstmateRoot(root);
          this._status = t("professional.firstmateRootSaved", {}, "Firstmate root saved.");
          await this.refresh();
        }
      } catch (error) {
        this._error = error?.message || String(error);
        this._render();
      }
    });
    this.querySelector("[data-firstmate-trust]")?.addEventListener("change", async (event) => {
      try {
        await this.transport.setFirstmateTrusted(event.target.checked);
        await this.refresh();
      } catch (error) {
        this._error = error?.message || String(error);
        this._render();
      }
    });
    this.querySelector("[data-pick-import-root]")?.addEventListener("click", async () => {
      const root = await this.transport.pickFolder();
      if (root) {
        this._importRoot = root;
        this._importPreview = null;
        this._selectedImports.clear();
        this._render();
      }
    });
    this.querySelector("[data-preview-import]")?.addEventListener("click", () =>
      this._previewImport(),
    );
    this.querySelectorAll("[data-import-candidate]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) this._selectedImports.add(input.dataset.importCandidate);
        else this._selectedImports.delete(input.dataset.importCandidate);
        this._render();
      });
    });
    this.querySelector("[data-apply-import]")?.addEventListener("click", () => this._applyImport());
    this.querySelectorAll("[data-activate-import]").forEach((button) => {
      button.addEventListener("click", () => this._activateImport(button.dataset.activateImport));
    });
    this.querySelector("[data-preview-mcp]")?.addEventListener("click", () => this._previewMcp());
    this.querySelectorAll("[data-activate-mcp]").forEach((button) => {
      button.addEventListener("click", () => this._activateMcp(button.dataset.activateMcp));
    });
    this.querySelectorAll("[data-mcp-enable]").forEach((input) => {
      input.addEventListener("change", async () => {
        try {
          await this.transport.setMcpEnabled(input.dataset.mcpEnable, input.checked);
          await this.refresh();
        } catch (error) {
          this._error = error?.message || String(error);
          this._render();
        }
      });
    });
    this.querySelectorAll("[data-mcp-trust]").forEach((input) => {
      input.addEventListener("change", async () => {
        try {
          await this.transport.setMcpTrusted(input.dataset.mcpTrust, input.checked);
          await this.refresh();
        } catch (error) {
          this._error = error?.message || String(error);
          this._render();
        }
      });
    });
    this.querySelectorAll("[data-mcp-candidate]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) this._selectedMcp.add(input.dataset.mcpCandidate);
        else this._selectedMcp.delete(input.dataset.mcpCandidate);
        this._render();
      });
    });
    this.querySelector("[data-apply-mcp]")?.addEventListener("click", () => this._applyMcp());
    this.querySelectorAll("[data-extension-enable]").forEach((input) => {
      input.addEventListener("change", async () => {
        try {
          await this.transport.setProfessionalExtensionEnabled(
            input.dataset.extensionEnable,
            input.checked,
          );
          await this.refresh();
        } catch (error) {
          this._error = error?.message || String(error);
          this._render();
        }
      });
    });
    this.querySelectorAll("[data-extension-trust]").forEach((input) => {
      input.addEventListener("change", async () => {
        try {
          await this.transport.setProfessionalExtensionTrusted(
            input.dataset.extensionTrust,
            input.checked,
          );
          await this.refresh();
        } catch (error) {
          this._error = error?.message || String(error);
          this._render();
        }
      });
    });
    this.querySelectorAll("[data-component-enable]").forEach((input) => {
      input.addEventListener("change", async () => {
        try {
          await this.transport.setExtensionComponentEnabled(
            input.dataset.componentEnable,
            input.checked,
          );
          await this.refresh();
        } catch (error) {
          this._error = error?.message || String(error);
          this._render();
        }
      });
    });
    this.querySelectorAll("[data-component-trust]").forEach((input) => {
      input.addEventListener("change", async () => {
        try {
          await this.transport.setExtensionComponentTrusted(
            input.dataset.componentTrust,
            input.checked,
          );
          await this.refresh();
        } catch (error) {
          this._error = error?.message || String(error);
          this._render();
        }
      });
    });
    this.querySelector("[data-herdr-reset]")?.addEventListener("click", async () => {
      try {
        await this.transport.resetHerdrDecision();
        this._status = t(
          "professional.herdrResetDone",
          {},
          "Herdr will be offered on the next interactive TUI start.",
        );
        await this.refresh();
      } catch (error) {
        this._error = error?.message || String(error);
        this._render();
      }
    });
    this.querySelector("[data-herdr-remove]")?.addEventListener("click", async () => {
      try {
        await this.transport.removeHerdr();
        this._status = t("professional.herdrRemoved", {}, "Herdr was removed.");
        await this.refresh();
      } catch (error) {
        this._error = error?.message || String(error);
        this._render();
      }
    });
    this.querySelector("[data-install-extension]")?.addEventListener("click", () =>
      this._installExtension(),
    );
    this.querySelector("[data-launch-dap]")?.addEventListener("click", () => this._launchDap());
    this.querySelector("[data-extension-scope]")?.addEventListener("change", (event) => {
      this.querySelector("[data-extension-task]").disabled = event.target.value !== "task";
    });
  }

  async _inspectEffectiveReport() {
    try {
      const taskId = this.querySelector("[data-effective-task]")?.value.trim();
      if (!taskId) throw new Error(t("professional.taskRequired", {}, "Enter a Task ID."));
      this._effectiveTask = taskId;
      const skills = (this._snapshot?.skills || []).map((skill) => ({
        id: skill.name || "skill",
        provenance: skill.source || skill.scope || "runtime skill catalog",
        active: true,
      }));
      this._effectiveReport = await this.transport.effectiveCapabilityReport(
        taskId,
        [],
        skills,
        [],
      );
      this._error = "";
    } catch (error) {
      this._error = error?.message || String(error);
    }
    this._render();
  }

  async _previewImport() {
    this._busy = true;
    this._status = t("common.working", {}, "Working…");
    try {
      const source = this.querySelector("[data-import-source]").value;
      this._importPreview = await this.transport.previewExternalCapabilityImport(
        source,
        this._importRoot,
      );
      this._selectedImports.clear();
      this._error = "";
    } catch (error) {
      this._error = error?.message || String(error);
    } finally {
      this._busy = false;
      this._status = "";
      this._render();
    }
  }

  async _installExtension() {
    try {
      const permissions = [];
      if (this.querySelector("[data-manifest-read]").checked) permissions.push("workspaceRead");
      if (this.querySelector("[data-manifest-process]").checked) permissions.push("processExecute");
      if (this.querySelector("[data-manifest-network]").checked) permissions.push("network");
      const id = this.querySelector("[data-manifest-id]").value.trim();
      await this.transport.installProfessionalExtension({
        id,
        manifestVersion: 2,
        schemaVersion: 1,
        name: id,
        version: "local-1",
        source: "local:manual",
        sourceRef: null,
        sourceHash: null,
        license: "unknown",
        components: ["native-helper"],
        platforms: [navigator.platform || "unknown"],
        healthCheck: { kind: "process", timeoutMs: 5000 },
        executable: this.querySelector("[data-manifest-executable]").value.trim(),
        arguments: this.querySelector("[data-manifest-args]").value.split(/\r?\n/).filter(Boolean),
        permissions,
        enabled: false,
        limits: { maxMemoryBytes: 536870912, maxOutputBytes: 65536 },
      });
      this._status = t("professional.installedDisabled", {}, "Extension installed disabled.");
      await this.refresh();
    } catch (error) {
      this._error = error?.message || String(error);
      this._render();
    }
  }

  async _launchDap() {
    try {
      const taskId = this.querySelector("[data-extension-task]")?.value.trim();
      if (!taskId) throw new Error(t("professional.taskRequired", {}, "Enter a Task ID."));
      const snapshot = await this.transport.taskSnapshot();
      const terminal = new Set(["completed", "failed", "cancelled", "terminated"]);
      const run = [...(snapshot.agentRuns || [])]
        .reverse()
        .find((item) => item.taskId === taskId && !terminal.has(item.state));
      if (!run)
        throw new Error(
          t("professional.activeRunRequired", {}, "The task needs an active Agent Run."),
        );
      await this.transport.launchDap(
        taskId,
        run.id,
        {
          adapter: this.querySelector("[data-dap-adapter]").value.trim(),
          arguments: this.querySelector("[data-dap-args]").value.split(/\r?\n/).filter(Boolean),
          request: this.querySelector("[data-dap-request]").value,
          target: this.querySelector("[data-dap-target]").value.trim(),
          maxEvents: 512,
        },
        this.querySelector("[data-dap-authorize]").checked,
        30 * 60 * 1000,
      );
      this._status = t("professional.dapStarted", {}, "Debugger started in the isolated host.");
      await this.refresh();
    } catch (error) {
      this._error = error?.message || String(error);
      this._render();
    }
  }

  async _applyImport() {
    try {
      this._busy = true;
      await this.transport.applyExternalCapabilityImport(
        this._importPreview.id,
        [...this._selectedImports],
        this._scope(),
      );
      this._status = t("professional.imported", {}, "Selected capabilities imported.");
      this._importPreview = null;
      this._selectedImports.clear();
      await this.refresh();
    } catch (error) {
      this._error = error?.message || String(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _activateImport(importedId) {
    try {
      const taskId = this.querySelector("[data-extension-task]")?.value.trim();
      if (!taskId) throw new Error(t("professional.taskRequired", {}, "Enter a Task ID."));
      await this.transport.activateImportedCapability(importedId, taskId);
      this._status = t("professional.activated", {}, "Workflow activated for the task.");
      await this.refresh();
    } catch (error) {
      this._error = error?.message || String(error);
      this._render();
    }
  }

  async _previewMcp() {
    try {
      const content = this.querySelector("[data-mcp-json]").value;
      this._mcpPreview = await this.transport.previewMcpImport(content);
      this._selectedMcp.clear();
      this._error = "";
    } catch (error) {
      this._error = error?.message || String(error);
    }
    this._render();
  }

  async _applyMcp() {
    try {
      const selected = {};
      for (const serverId of this._selectedMcp) {
        const candidate = this._mcpPreview.candidates.find((item) => item.id === serverId);
        selected[serverId] = {};
        for (const name of candidate.requiredEnvironment || []) {
          const key = `${serverId}:${name}`;
          const kindInput = [...this.querySelectorAll("[data-secret-kind]")].find(
            (element) => element.dataset.secretKind === key,
          );
          const valueInput = [...this.querySelectorAll("[data-secret-value]")].find(
            (element) => element.dataset.secretValue === key,
          );
          if (!kindInput || !valueInput) {
            throw new Error(
              t("professional.secretRefRequired", {}, "Every secret field needs a reference."),
            );
          }
          const kind = kindInput.value;
          const value = valueInput.value.trim();
          if (!value)
            throw new Error(
              t("professional.secretRefRequired", {}, "Every secret field needs a reference."),
            );
          if (kind === "environment")
            selected[serverId][name] = { kind: "environment", name: value };
          if (kind === "file") selected[serverId][name] = { kind: "file", path: value };
          if (kind === "credential") {
            const [service, account] = value.split("/", 2);
            if (!service || !account)
              throw new Error(
                t(
                  "professional.credentialFormat",
                  {},
                  "Use service/account for an OS credential reference.",
                ),
              );
            selected[serverId][name] = { kind: "credential", service, account };
          }
        }
      }
      await this.transport.applyMcpImport(this._mcpPreview.id, selected, this._scope());
      this._mcpPreview = null;
      this._selectedMcp.clear();
      this._status = t(
        "professional.mcpImported",
        {},
        "Selected MCP servers imported. They remain stopped.",
      );
      await this.refresh();
    } catch (error) {
      this._error = error?.message || String(error);
      this._render();
    }
  }

  async _activateMcp(serverId) {
    try {
      const taskId = this.querySelector("[data-extension-task]")?.value.trim();
      if (!taskId) throw new Error(t("professional.taskRequired", {}, "Enter a Task ID."));
      await this.transport.activateMcpServer(serverId, taskId);
      this._status = t("professional.mcpActivated", {}, "MCP tools enabled for the task.");
      await this.refresh();
    } catch (error) {
      this._error = error?.message || String(error);
      this._render();
    }
  }
}

if (!customElements.get("picode-professional-extensions")) {
  customElements.define("picode-professional-extensions", PicodeProfessionalExtensions);
}
