import { getTransport } from "../app/transport.js";
import { t } from "../i18n/index.js";

const POLICY_KEY = "picode:subagent-model-policy:v1";

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  fallback: "doNotDelegate",
  candidates: [],
  qualifiedClasses: ["repository-search", "advisory-review"],
});

export function loadSubagentPolicy(storage = globalThis.localStorage) {
  try {
    return normalizeSubagentPolicy(JSON.parse(storage?.getItem?.(POLICY_KEY) || "null"));
  } catch {
    return structuredClone(DEFAULT_POLICY);
  }
}

function normalizeSubagentPolicy(value) {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_POLICY);
  return {
    enabled: value.enabled === true,
    fallback: ["doNotDelegate", "inheritMain", "ask"].includes(value.fallback)
      ? value.fallback
      : "doNotDelegate",
    candidates: Array.isArray(value.candidates)
      ? value.candidates.filter(
          (candidate) =>
            typeof candidate?.id === "string" &&
            candidate.id.includes("/") &&
            [candidate.capability, candidate.quality, candidate.costRank].every(Number.isFinite),
        )
      : [],
    qualifiedClasses: Array.isArray(value.qualifiedClasses)
      ? value.qualifiedClasses.filter((item) => typeof item === "string")
      : ["repository-search", "advisory-review"],
  };
}

function parseCandidates(source) {
  if (!source.trim()) return [];
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [id, capability, quality, costRank] = line.split(",").map((value) => value.trim());
      const scores = [capability, quality, costRank].map(Number);
      if (!id?.includes("/") || scores.some((value) => !Number.isFinite(value))) {
        throw new Error("Each row must be: provider/model, capability, quality, cost rank");
      }
      return {
        id,
        capability: scores[0],
        quality: scores[1],
        costRank: scores[2],
        healthy: true,
      };
    });
}

class PicodeSubagentPolicy extends HTMLElement {
  get transport() {
    return this._transport || getTransport();
  }

  set transport(value) {
    this._transport = value;
  }

  connectedCallback() {
    this._policy = loadSubagentPolicy();
    this.render();
    void this.hydrate();
  }

  render() {
    const policy = this._policy || loadSubagentPolicy();
    this.innerHTML = `
      <div class="settings-section-title">${t("subagentPolicy.title", {}, "Subagent model policy")}</div>
      <p class="settings-help">${t("subagentPolicy.help", {}, "Configuration never starts work. Only bounded, independently verifiable read tasks can qualify.")}</p>
      <label class="settings-row"><span class="settings-label">${t("subagentPolicy.enabled", {}, "Allow qualified delegation")}</span><input data-enabled type="checkbox" ${policy.enabled ? "checked" : ""}></label>
      <label class="picode-policy-field"><span>${t("subagentPolicy.candidates", {}, "Eligible models")}</span><textarea data-candidates rows="4" spellcheck="false" placeholder="provider/model, 10, 9, 1">${policy.candidates.map((candidate) => `${candidate.id},${candidate.capability},${candidate.quality},${candidate.costRank}`).join("\n")}</textarea></label>
      <label class="picode-policy-field"><span>${t("subagentPolicy.fallback", {}, "Unavailable-model fallback")}</span><select data-fallback class="ui-select"><option value="doNotDelegate">${t("subagentPolicy.doNotDelegate", {}, "Do not delegate")}</option><option value="inheritMain">${t("subagentPolicy.inheritMain", {}, "Inherit main model")}</option><option value="ask">${t("subagentPolicy.ask", {}, "Ask")}</option></select></label>
      <label class="picode-policy-field"><span>${t("subagentPolicy.classes", {}, "Qualified evaluation classes")}</span><input data-classes class="ui-input" value="${policy.qualifiedClasses.join(", ")}"></label>
      <div class="picode-policy-actions"><button data-save type="button" class="ui-button ui-button--secondary">${t("common.save", {}, "Save")}</button><span data-status role="status"></span></div>`;
    this.querySelector("[data-fallback]").value = policy.fallback;
    this.querySelector("[data-save]").addEventListener("click", () => this.save());
  }

  async hydrate() {
    if (typeof this.transport?.getSubagentPolicy !== "function") return;
    try {
      const policy = normalizeSubagentPolicy(await this.transport.getSubagentPolicy());
      this._policy = policy;
      localStorage.setItem(POLICY_KEY, JSON.stringify(policy));
      if (this.isConnected) this.render();
    } catch {
      // Offline startup keeps the last local cache; the Rust store remains authoritative when connected.
    }
  }

  async save() {
    const status = this.querySelector("[data-status]");
    try {
      const policy = {
        enabled: this.querySelector("[data-enabled]").checked,
        fallback: this.querySelector("[data-fallback]").value,
        candidates: parseCandidates(this.querySelector("[data-candidates]").value),
        qualifiedClasses: this.querySelector("[data-classes]")
          .value.split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      };
      this._policy = policy;
      localStorage.setItem(POLICY_KEY, JSON.stringify(policy));
      await this.transport.setSubagentPolicy(policy);
      status.textContent = t("common.saved", {}, "Saved");
      this.dispatchEvent(new CustomEvent("picode-subagent-policy-changed", { detail: policy }));
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
  }
}

if (!customElements.get("picode-subagent-policy")) {
  customElements.define("picode-subagent-policy", PicodeSubagentPolicy);
}
