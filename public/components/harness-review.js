import { getTransport } from "../app/transport.js";
import { t } from "../i18n/index.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export class PicodeHarnessReview extends HTMLElement {
  connectedCallback() {
    this._selected = new Set();
    this._review = null;
    this._result = null;
    this._busy = false;
    this._render();
  }

  get transport() {
    return this._transport || getTransport();
  }

  set transport(value) {
    this._transport = value;
  }

  async open(task) {
    this._task = task;
    this._selected = new Set();
    this._result = null;
    this._busy = true;
    this.setAttribute("open", "");
    this._render();
    try {
      this._review = await this.transport.reviewHarness(task.id);
      this._error = "";
    } catch (error) {
      this._error = error?.message || String(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  close() {
    if (this._busy) return;
    this.removeAttribute("open");
  }

  _render() {
    const profile = this._review?.profile;
    const candidates = this._review?.candidates || [];
    const actions = profile?.actions || [];
    this.innerHTML = `
      <div class="picode-harness-review__backdrop" data-close></div>
      <aside class="picode-harness-review__drawer" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("harness.title", {}, "Harness review"))}">
        <header>
          <div><span class="picode-eyebrow">HARNESS</span><h2>${escapeHtml(t("harness.title", {}, "Harness review"))}</h2></div>
          <button type="button" class="picode-icon-button" data-close aria-label="${escapeHtml(t("common.close", {}, "Close"))}">×</button>
        </header>
        <p class="picode-harness-review__intro">${escapeHtml(t("harness.reviewHelp", {}, "Review discovered commands. Nothing becomes trusted until you select and confirm it."))}</p>
        ${this._busy ? `<p class="picode-harness-review__status">${escapeHtml(t("common.working", {}, "Working…"))}</p>` : ""}
        ${this._error ? `<p class="picode-runtime-error">${escapeHtml(this._error)}</p>` : ""}
        ${profile ? this._actions(actions) : this._candidates(candidates)}
        ${this._result ? `<pre class="picode-harness-output" data-harness-output>${escapeHtml(this._result.execution?.stdout || this._result.execution?.stderr || "")}</pre>` : ""}
      </aside>`;
    this.querySelectorAll("[data-close]").forEach((button) => {
      button.addEventListener("click", () => this.close());
    });
    this.querySelectorAll("[data-candidate]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) this._selected.add(input.value);
        else this._selected.delete(input.value);
        this._render();
      });
    });
    this.querySelector("[data-confirm]")?.addEventListener("click", () => this._confirm());
    this.querySelectorAll("[data-run-action]").forEach((button) => {
      button.addEventListener("click", () => this._run(button.dataset.runAction));
    });
  }

  _candidates(candidates) {
    if (!candidates.length && !this._busy) {
      return `<p class="picode-runtime-empty">${escapeHtml(t("harness.noCandidates", {}, "No candidate actions were discovered."))}</p>`;
    }
    return `<div class="picode-harness-candidates">
      ${candidates
        .map(
          (candidate) => `<label class="picode-harness-candidate">
            <input type="checkbox" data-candidate value="${escapeHtml(candidate.id)}" ${this._selected.has(candidate.id) ? "checked" : ""}>
            <span><strong>${escapeHtml(candidate.id)}</strong><code>${escapeHtml(candidate.command)}</code><small>${escapeHtml(candidate.source)}</small></span>
          </label>`,
        )
        .join("")}
      <button type="button" class="picode-button picode-button--primary" data-confirm ${this._selected.size && !this._busy ? "" : "disabled"}>${escapeHtml(t("harness.confirm", {}, "Confirm selected actions"))}</button>
    </div>`;
  }

  _actions(actions) {
    return `<div class="picode-harness-actions">
      ${actions
        .map(
          (action) =>
            `<article><div><strong>${escapeHtml(action.id)}</strong><small>${escapeHtml(action.risk)}</small></div><button type="button" class="picode-button picode-button--secondary" data-run-action="${escapeHtml(action.id)}" ${this._busy ? "disabled" : ""}>${escapeHtml(t("harness.run", {}, "Run"))}</button></article>`,
        )
        .join("")}
    </div>`;
  }

  async _confirm() {
    if (!this._selected.size || this._busy) return;
    this._busy = true;
    this._render();
    try {
      const confirmed = await this.transport.confirmHarness(this._task.id, [...this._selected]);
      this._review = { ...this._review, profileExists: true, profile: confirmed.profile };
      this._error = "";
    } catch (error) {
      this._error = error?.message || String(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _run(actionId) {
    if (this._busy) return;
    this._busy = true;
    this._render();
    try {
      this._result = await this.transport.runHarnessAction(this._task.id, actionId, {}, false);
      this._error = this._result.passed
        ? ""
        : t("harness.actionFailed", {}, "The Harness Action did not pass.");
    } catch (error) {
      this._error = error?.message || String(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }
}

if (!customElements.get("picode-harness-review")) {
  customElements.define("picode-harness-review", PicodeHarnessReview);
}
