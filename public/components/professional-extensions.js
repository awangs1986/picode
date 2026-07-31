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

function skillBundleLabel(source) {
  const normalized = String(source || "")
    .replace(/^git:/, "")
    .replace(/^npm:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "");
  return normalized || t("professional.individualSkill", {}, "Individual skill");
}

export function groupInstalledSkills(skills) {
  const groups = new Map();
  for (const [index, skill] of (skills || []).entries()) {
    const source = String(skill?.source || "");
    const bundled = skill?.origin === "package" && source && source !== "unknown";
    const key = bundled ? `bundle:${source}` : `skill:${index}:${skill?.name || "unknown"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        bundled,
        label: bundled ? skillBundleLabel(source) : skill?.name || "skill",
        source,
        skills: [],
      });
    }
    groups.get(key).skills.push(skill);
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export class PicodeProfessionalExtensions extends HTMLElement {
  connectedCallback() {
    this._snapshot ||= null;
    this._capabilitySnapshot ||= null;
    this._skills ||= null;
    this._firstmateStatus ||= null;
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
    const taskSnapshot = this.transport.taskSnapshot
      ? await Promise.resolve()
          .then(() => this.transport.taskSnapshot())
          .catch((error) => {
            errors.push(error);
            return null;
          })
      : null;
    if (taskSnapshot) this._snapshot = taskSnapshot?.extensions || {};

    const capabilitySnapshot = this.transport.capabilitySnapshot
      ? await Promise.resolve()
          .then(() => this.transport.capabilitySnapshot())
          .catch((error) => {
            errors.push(error);
            return null;
          })
      : null;
    if (capabilitySnapshot) this._capabilitySnapshot = capabilitySnapshot;

    if (this.transport.listSkills) {
      const skills = await Promise.resolve()
        .then(() => this.transport.listSkills())
        .catch((error) => {
          errors.push(error);
          return null;
        });
      if (skills) this._skills = Array.isArray(skills) ? skills : [];
    }

    if (this.transport.firstmateStatus) {
      const firstmateStatus = await Promise.resolve()
        .then(() => this.transport.firstmateStatus())
        .catch((error) => {
          errors.push(error);
          return null;
        });
      if (firstmateStatus) this._firstmateStatus = firstmateStatus;
    }

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
    const skills = this._skills || [];
    const skillGroups = groupInstalledSkills(skills);
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
          <header><div><span class="picode-eyebrow">SKILLS</span><h3>${escapeHtml(t("professional.skills", {}, "Installed skills"))}</h3></div><small>${this._skills === null ? "—" : skills.length}</small></header>
          <p class="settings-help">${escapeHtml(t("professional.skillsHelp", {}, "Skills loaded by the current Pi runtime are available from the slash menu and are shown here for verification."))}</p>
          ${this._skills === null ? `<p class="picode-runtime-empty">${escapeHtml(t("professional.skillsLoading", {}, "Loading skills…"))}</p>` : skills.length ? `<div class="picode-imported-list">${skillGroups.map((group) => this._skillGroup(group)).join("")}</div>` : `<p class="picode-runtime-empty">${escapeHtml(t("professional.noSkills", {}, "No skills are currently loaded."))}</p>`}
        </section>
        ${`<section class="picode-professional-card picode-professional-card--wide">
          <header><div><span class="picode-eyebrow">CAPABILITIES</span><h3>${escapeHtml(t("professional.capabilities", {}, "Optional capabilities"))}</h3></div><small>${capabilities.length}</small></header>
          <p class="settings-help">${escapeHtml(t("professional.capabilitiesHelp", {}, "Disabled modules stay out of the Agent catalog and consume no process resources."))}</p>
          ${capabilities.length ? `<div class="picode-imported-list">${capabilities.map((item) => this._capabilityRow(item)).join("")}</div>` : `<p class="picode-runtime-empty">${escapeHtml(t("professional.noCapabilities", {}, "No optional capabilities are available."))}</p>`}
        </section>`}
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
          ${mcp.length ? `<div class="picode-imported-list">${mcp.map((item) => `<div class="picode-import-candidate"><span><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.transport)} · ${escapeHtml(item.scope === "global" ? "global" : item.scope?.task || "task")}</small></span><button type="button" class="ui-button ui-button--secondary" data-activate-mcp="${escapeHtml(item.id)}">${escapeHtml(t("professional.activateMcp", {}, "Enable for task"))}</button></div>`).join("")}</div>` : ""}
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
    return `<label class="picode-extension-install" data-extension="${escapeHtml(item.id)}">
      <span><strong>${escapeHtml(item.id)}</strong><small>schema ${escapeHtml(item.schemaVersion)} · ${escapeHtml(permissions || "no permissions")}</small></span>
      <input type="checkbox" data-extension-enable="${escapeHtml(item.id)}" ${item.enabled ? "checked" : ""}>
    </label>`;
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

  _capabilityRow(item) {
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
        ? `<div class="picode-firstmate-root"><small>${escapeHtml(this._firstmateStatus?.available ? `${t("professional.firstmateRootReady", {}, "Root ready")}: ${this._firstmateStatus.root}` : t("professional.firstmateRootMissing", {}, "Choose a Firstmate directory containing AGENTS.md"))}</small><button type="button" class="ui-button ui-button--secondary ui-button--sm" data-firstmate-pick-root>${escapeHtml(t("professional.firstmateChooseRoot", {}, "Choose root"))}</button></div>`
        : "";
    return `<label class="picode-import-candidate" data-capability="${escapeHtml(item.id)}">
      <span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(summary)} · ${escapeHtml(status)} · ${escapeHtml(tierLabel)}</small>${firstmateRoot}</span>
      <select class="ui-select" data-capability-tier="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.id)} tier">
        <option value="disabled" ${disabled ? "selected" : ""}>${escapeHtml(t("professional.capabilityDisabled", {}, "Disabled"))}</option>
        <option value="discoverable" ${tier === "discoverable" ? "selected" : ""}>${escapeHtml(t("professional.capabilityDiscoverable", {}, "Discoverable"))}</option>
      </select>
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
    this.querySelector("[data-install-extension]")?.addEventListener("click", () =>
      this._installExtension(),
    );
    this.querySelector("[data-launch-dap]")?.addEventListener("click", () => this._launchDap());
    this.querySelector("[data-extension-scope]")?.addEventListener("change", (event) => {
      this.querySelector("[data-extension-task]").disabled = event.target.value !== "task";
    });
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
      await this.transport.installProfessionalExtension({
        id: this.querySelector("[data-manifest-id]").value.trim(),
        schemaVersion: 1,
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
