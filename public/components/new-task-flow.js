import { getTransport } from "../app/transport.js";
import { t } from "../i18n/index.js";
import { TaskExperience } from "./task-experience.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export class PicodeTaskDialog extends HTMLElement {
  connectedCallback() {
    this._mode = "conversation";
    this._chatId = null;
    this._busy = false;
    this._render();
    this._onKeyDown = (event) => {
      if (event.key === "Escape" && this.hasAttribute("open") && !this._busy) this.close();
    };
    document.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("picot:locale-changed", this._onLocaleChanged);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("picot:locale-changed", this._onLocaleChanged);
  }

  get transport() {
    return this._transport || getTransport();
  }

  set transport(value) {
    this._transport = value;
  }

  open({ chatId = null } = {}) {
    this._chatId = chatId || `chat-${crypto.randomUUID()}`;
    this._mode = "conversation";
    this._busy = false;
    this.setAttribute("open", "");
    this._render();
    queueMicrotask(() => this.querySelector("[data-goal]")?.focus());
  }

  close() {
    this.removeAttribute("open");
    this._busy = false;
    this._render();
  }

  _onLocaleChanged = () => {
    if (this.isConnected) this._render();
  };

  _render() {
    const open = this.hasAttribute("open");
    this.innerHTML = `
      <div class="picode-task-dialog__backdrop" ${open ? "" : "hidden"} data-close></div>
      <section class="picode-task-dialog__card" ${open ? "" : "hidden"} role="dialog" aria-modal="true" aria-labelledby="picode-task-dialog-title">
        <header>
          <div>
            <span class="picode-eyebrow">${escapeHtml(t("task.newEyebrow", {}, "NEW TASK"))}</span>
            <h2 id="picode-task-dialog-title">${escapeHtml(t("task.newTitle", {}, "Create task"))}</h2>
          </div>
          <button type="button" class="picode-icon-button" data-close aria-label="${escapeHtml(t("common.close", {}, "Close"))}">×</button>
        </header>
        <form>
          <div class="picode-task-kind-grid" role="radiogroup" aria-label="${escapeHtml(t("task.kind", {}, "Task kind"))}">
            ${this._kindCard("conversation", "task.simple", "Lightweight task", "task.simpleHelp", "Start chatting without choosing a project.")}
            ${this._kindCard("project", "task.harness", "Project task", "task.harnessHelp", "Choose a project and let Picode manage the development workflow and verification.")}
          </div>
          <label class="picode-task-goal">
            <span>${escapeHtml(t("task.goal", {}, "Goal (optional)"))}</span>
            <textarea data-goal rows="3" placeholder="${escapeHtml(t("task.goalPlaceholder", {}, "Describe a goal, or leave blank to start chatting."))}"></textarea>
          </label>
          <p class="picode-task-note">${escapeHtml(this._mode === "conversation" ? t("task.simpleStartup", {}, "Starts immediately. Add more capabilities only when you need them.") : t("task.harnessStartup", {}, "Next, choose a project folder. Picode will prepare the workspace and verification flow."))}</p>
          <div class="picode-task-actions">
            <button type="button" class="picode-button picode-button--secondary" data-close>${escapeHtml(t("common.cancel", {}, "Cancel"))}</button>
            <button type="submit" class="picode-button picode-button--primary" ${this._busy ? "disabled" : ""}>${escapeHtml(this._busy ? t("common.working", {}, "Working…") : t("task.create", {}, "Create task"))}</button>
          </div>
          <div class="picode-task-error" data-error role="alert"></div>
        </form>
      </section>`;
    for (const button of this.querySelectorAll("[data-close]")) {
      button.addEventListener("click", () => {
        if (!this._busy) this.close();
      });
    }
    for (const button of this.querySelectorAll("[data-kind]")) {
      button.addEventListener("click", () => {
        if (this._busy) return;
        this._mode = button.dataset.kind;
        const draft = this.querySelector("[data-goal]")?.value || "";
        this._render();
        this.querySelector("[data-goal]").value = draft;
      });
    }
    this.querySelector("form")?.addEventListener("submit", (event) => this._submit(event));
  }

  _kindCard(kind, titleId, titleFallback, helpId, helpFallback) {
    const selected = this._mode === kind;
    return `<button type="button" class="picode-task-kind ${selected ? "is-selected" : ""}" data-kind="${kind}" role="radio" aria-checked="${selected}">
      <span class="picode-task-kind__icon">${kind === "conversation" ? "C" : "P"}</span>
      <span><strong>${escapeHtml(t(titleId, {}, titleFallback))}</strong><small>${escapeHtml(t(helpId, {}, helpFallback))}</small></span>
      <i>${selected ? "✓" : ""}</i>
    </button>`;
  }

  async _submit(event) {
    event.preventDefault();
    if (this._busy) return;
    const goal = this.querySelector("[data-goal]")?.value.trim() || "";
    const transport = this.transport;
    if (!transport) {
      this._showError(t("task.transportUnavailable", {}, "Task Control is not connected."));
      return;
    }
    this._busy = true;
    this._render();
    try {
      const task = await new TaskExperience(transport).createTask({
        chatId: this._chatId,
        goal,
        mode: this._mode,
      });
      if (!task) {
        this._busy = false;
        this._render();
        return;
      }
      this.dispatchEvent(new CustomEvent("picode-task-created", { bubbles: true, detail: task }));
      this.close();
    } catch (error) {
      this._busy = false;
      this._render();
      this._showError(error?.message || String(error));
    }
  }

  _showError(message) {
    const target = this.querySelector("[data-error]");
    if (target) target.textContent = message;
  }
}

if (!customElements.get("picode-task-dialog")) {
  customElements.define("picode-task-dialog", PicodeTaskDialog);
}
