import { getTransport } from "../app/transport.js";
import { t } from "../i18n/index.js";
import {
  filterModelsByProvider,
  modelOptionLabel,
  summarizeModelProviders,
} from "../models/provider-view.js";

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

export async function fetchAvailableSubagentModels(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return [];
  const response = await fetchImpl("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "get_available_models" }),
  });
  const payload = await response.json();
  if (!payload?.success || !Array.isArray(payload.data?.models)) return [];
  const seen = new Set();
  return payload.data.models.filter((model) => {
    const candidateId = modelCandidateId(model);
    if (!candidateId || seen.has(candidateId)) return false;
    seen.add(candidateId);
    return true;
  });
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

function modelCandidateId(model) {
  const provider = String(model?.provider || "").trim();
  const id = String(model?.id || "").trim();
  return provider && id ? `${provider}/${id}` : "";
}

function modelFromCandidateId(candidateId) {
  const separator = candidateId.indexOf("/");
  if (separator < 1) return { provider: "", id: candidateId };
  return {
    provider: candidateId.slice(0, separator),
    id: candidateId.slice(separator + 1),
  };
}

function createCandidate(model, selectionIndex) {
  return {
    id: modelCandidateId(model),
    capability: 10,
    quality: 10,
    costRank: Math.min(selectionIndex, 10),
    healthy: true,
  };
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
    this._draftCandidates = structuredClone(this._policy.candidates);
    this._availableModels = [];
    this._onDocumentClick ||= (event) => {
      if (!this.contains(event.target)) this.closeModelPicker();
    };
    document.addEventListener("click", this._onDocumentClick);
    this.render();
    void this.hydrate();
    void this.loadAvailableModels();
  }

  disconnectedCallback() {
    document.removeEventListener("click", this._onDocumentClick);
  }

  render() {
    const policy = this._policy || loadSubagentPolicy();
    this.innerHTML = `
      <div class="settings-section-title">${t("subagentPolicy.title", {}, "Subagent model policy")}</div>
      <p class="settings-help">${t("subagentPolicy.help", {}, "Configuration never starts work. Only bounded, independently verifiable read tasks can qualify.")}</p>
      <label class="settings-row"><span class="settings-label">${t("subagentPolicy.enabled", {}, "Allow qualified delegation")}</span><input data-enabled type="checkbox" ${policy.enabled ? "checked" : ""}></label>
      <div class="picode-policy-field">
        <span>${t("subagentPolicy.candidates", {}, "Eligible models")}</span>
        <div class="model-dropdown picode-policy-model-picker" data-model-picker>
          <button data-model-picker-button type="button" class="model-dropdown-btn" aria-haspopup="listbox" aria-expanded="false">
            <span data-model-picker-label></span>
            <svg class="model-dropdown-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div data-model-picker-menu class="model-dropdown-menu hidden" role="listbox" aria-multiselectable="true"></div>
        </div>
        <span class="settings-help">${t("subagentPolicy.modelPickerHelp", {}, "Uses the same enabled model list as chat. Selections apply only to qualified Subagent work.")}</span>
      </div>
      <label class="picode-policy-field"><span>${t("subagentPolicy.fallback", {}, "Unavailable-model fallback")}</span><select data-fallback class="ui-select"><option value="doNotDelegate">${t("subagentPolicy.doNotDelegate", {}, "Do not delegate")}</option><option value="inheritMain">${t("subagentPolicy.inheritMain", {}, "Inherit main model")}</option><option value="ask">${t("subagentPolicy.ask", {}, "Ask")}</option></select></label>
      <label class="picode-policy-field"><span>${t("subagentPolicy.classes", {}, "Qualified evaluation classes")}</span><input data-classes class="ui-input" value="${policy.qualifiedClasses.join(", ")}"></label>
      <div class="picode-policy-actions"><button data-save type="button" class="ui-button ui-button--secondary">${t("common.save", {}, "Save")}</button><span data-status role="status"></span></div>`;
    this.querySelector("[data-fallback]").value = policy.fallback;
    this.updateModelPickerLabel();
    this.querySelector("[data-model-picker-button]").addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleModelPicker();
    });
    this.querySelector("[data-save]").addEventListener("click", () => this.save());
  }

  async hydrate() {
    if (typeof this.transport?.getSubagentPolicy !== "function") return;
    try {
      const policy = normalizeSubagentPolicy(await this.transport.getSubagentPolicy());
      this._policy = policy;
      this._draftCandidates = structuredClone(policy.candidates);
      localStorage.setItem(POLICY_KEY, JSON.stringify(policy));
      if (this.isConnected) this.render();
    } catch {
      // Offline startup keeps the last local cache; the Rust store remains authoritative when connected.
    }
  }

  async loadAvailableModels() {
    try {
      this._availableModels = await fetchAvailableSubagentModels();
      if (this.isConnected) this.render();
    } catch {
      this._availableModels = [];
      if (this.isConnected) this.render();
    }
  }

  toggleModelPicker() {
    const menu = this.querySelector("[data-model-picker-menu]");
    if (menu.classList.contains("hidden")) this.openModelPicker();
    else this.closeModelPicker();
  }

  openModelPicker() {
    const picker = this.querySelector("[data-model-picker]");
    const button = this.querySelector("[data-model-picker-button]");
    const menu = this.querySelector("[data-model-picker-menu]");
    if (!picker || !button || !menu) return;
    menu.replaceChildren();
    let selectedProvider = "";

    const search = document.createElement("input");
    search.className = "model-dropdown-search";
    search.placeholder = t("models.search", {}, "Search models…");
    search.type = "search";
    menu.appendChild(search);

    const providerFilters = document.createElement("div");
    providerFilters.className = "model-dropdown-provider-filters";
    providerFilters.setAttribute("aria-label", t("models.providerFilter", {}, "Model provider"));
    menu.appendChild(providerFilters);

    const items = document.createElement("div");
    items.className = "model-dropdown-items";
    menu.appendChild(items);

    const renderItems = (filter = "") => {
      items.replaceChildren();
      const query = filter.trim().toLowerCase();
      const models = filterModelsByProvider(this._availableModels, selectedProvider);
      if (models.length === 0) {
        const empty = document.createElement("div");
        empty.className = "model-dropdown-empty";
        empty.textContent = t("models.none", {}, "No models available");
        items.appendChild(empty);
        return;
      }
      for (const model of models) {
        const label = modelOptionLabel(model);
        if (query && !label.toLowerCase().includes(query)) continue;
        const candidateId = modelCandidateId(model);
        const selected = this._draftCandidates.some((candidate) => candidate.id === candidateId);
        const item = document.createElement("button");
        item.type = "button";
        item.className = `model-dropdown-item${selected ? " active" : ""}`;
        item.dataset.modelCandidateId = candidateId;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(selected));

        const name = document.createElement("span");
        name.className = "model-dropdown-item-name";
        name.textContent = label;
        item.appendChild(name);
        const context = document.createElement("span");
        context.className = "model-dropdown-item-ctx";
        context.textContent = model.contextWindow
          ? `${Math.round(model.contextWindow / 1000)}k`
          : "";
        item.appendChild(context);
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          const index = this._draftCandidates.findIndex(
            (candidate) => candidate.id === candidateId,
          );
          if (index >= 0) this._draftCandidates.splice(index, 1);
          else this._draftCandidates.push(createCandidate(model, this._draftCandidates.length));
          this.updateModelPickerLabel();
          renderItems(search.value);
        });
        items.appendChild(item);
      }
    };

    const renderProviderFilters = () => {
      providerFilters.replaceChildren();
      const options = [
        {
          provider: "",
          label: t("models.providerAll", {}, "All"),
          count: this._availableModels.length,
        },
        ...summarizeModelProviders(this._availableModels),
      ];
      for (const option of options) {
        const filter = document.createElement("button");
        filter.type = "button";
        filter.className = `model-dropdown-provider-filter${selectedProvider === option.provider ? " active" : ""}`;
        filter.textContent = `${option.label} ${option.count}`;
        filter.setAttribute("aria-pressed", String(selectedProvider === option.provider));
        filter.addEventListener("click", (event) => {
          event.stopPropagation();
          selectedProvider = option.provider;
          renderProviderFilters();
          renderItems(search.value);
        });
        providerFilters.appendChild(filter);
      }
    };

    search.addEventListener("input", () => renderItems(search.value));
    search.addEventListener("click", (event) => event.stopPropagation());
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeModelPicker();
    });
    renderProviderFilters();
    renderItems();
    menu.classList.remove("hidden");
    picker.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    search.focus();
  }

  closeModelPicker() {
    const picker = this.querySelector("[data-model-picker]");
    const button = this.querySelector("[data-model-picker-button]");
    const menu = this.querySelector("[data-model-picker-menu]");
    menu?.classList.add("hidden");
    picker?.classList.remove("open");
    button?.setAttribute("aria-expanded", "false");
  }

  updateModelPickerLabel() {
    const label = this.querySelector("[data-model-picker-label]");
    if (!label) return;
    if (this._draftCandidates.length === 0) {
      label.textContent = t("subagentPolicy.selectModels", {}, "Select Subagent models…");
      return;
    }
    if (this._draftCandidates.length > 1) {
      label.textContent = t(
        "subagentPolicy.selectedCount",
        { count: this._draftCandidates.length },
        `${this._draftCandidates.length} models selected`,
      );
      return;
    }
    const candidateId = this._draftCandidates[0].id;
    const model =
      this._availableModels.find((item) => modelCandidateId(item) === candidateId) ||
      modelFromCandidateId(candidateId);
    label.textContent = modelOptionLabel(model);
  }

  async save() {
    const status = this.querySelector("[data-status]");
    try {
      const policy = {
        enabled: this.querySelector("[data-enabled]").checked,
        fallback: this.querySelector("[data-fallback]").value,
        candidates: structuredClone(this._draftCandidates),
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
