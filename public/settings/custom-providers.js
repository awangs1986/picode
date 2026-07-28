import { t } from "../i18n/index.js";

function slugifyProviderId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function parseModelIds(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[\n,]+/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

export function setupCustomProviderSettings({ transport, onChanged = async () => {} }) {
  const openButton = document.getElementById("custom-provider-add");
  const form = document.getElementById("custom-provider-form");
  const nameInput = document.getElementById("custom-provider-name");
  const idInput = document.getElementById("custom-provider-id");
  const apiSelect = document.getElementById("custom-provider-api");
  const baseUrlInput = document.getElementById("custom-provider-base-url");
  const apiKeyInput = document.getElementById("custom-provider-api-key");
  const modelsInput = document.getElementById("custom-provider-models");
  const status = document.getElementById("custom-provider-status");
  const cancelButton = document.getElementById("custom-provider-cancel");
  const discoverButton = document.getElementById("custom-provider-discover");
  const saveButton = document.getElementById("custom-provider-save");
  if (
    !openButton ||
    !form ||
    !nameInput ||
    !idInput ||
    !apiSelect ||
    !baseUrlInput ||
    !apiKeyInput ||
    !modelsInput ||
    !status ||
    !cancelButton ||
    !discoverButton ||
    !saveButton
  ) {
    return {};
  }

  let idWasEdited = false;
  let statusMessage = null;

  function showStatus(id, variables = {}, fallback = id, kind = "info") {
    statusMessage = id ? { id, variables, fallback, kind } : null;
    status.hidden = !statusMessage;
    status.dataset.kind = kind;
    status.textContent = statusMessage ? t(id, variables, fallback) : "";
  }

  function showRawStatus(message, kind = "error") {
    statusMessage = message ? { raw: String(message), kind } : null;
    status.hidden = !statusMessage;
    status.dataset.kind = kind;
    status.textContent = statusMessage?.raw || "";
  }

  function setBusy(busy) {
    discoverButton.disabled = busy;
    saveButton.disabled = busy;
    cancelButton.disabled = busy;
  }

  function values() {
    return {
      providerId: idInput.value.trim(),
      displayName: nameInput.value.trim(),
      api: apiSelect.value,
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      modelIds: parseModelIds(modelsInput.value),
    };
  }

  function hasConnectionFields(value) {
    return value.providerId && value.displayName && value.baseUrl && value.apiKey;
  }

  function close() {
    form.classList.add("hidden");
    openButton.hidden = false;
    apiKeyInput.value = "";
    showStatus(null);
  }

  openButton.addEventListener("click", () => {
    form.classList.remove("hidden");
    openButton.hidden = true;
    idWasEdited = Boolean(idInput.value.trim());
    requestAnimationFrame(() => nameInput.focus());
  });
  cancelButton.addEventListener("click", close);
  nameInput.addEventListener("input", () => {
    if (!idWasEdited) idInput.value = slugifyProviderId(nameInput.value);
  });
  idInput.addEventListener("input", () => {
    idWasEdited = true;
    const normalized = slugifyProviderId(idInput.value);
    if (normalized !== idInput.value) idInput.value = normalized;
  });

  discoverButton.addEventListener("click", async () => {
    const value = values();
    if (!hasConnectionFields(value)) {
      showStatus(
        "customProviders.required",
        {},
        "Complete the provider name, ID, Base URL, and API Key first.",
        "error",
      );
      return;
    }
    setBusy(true);
    showStatus("customProviders.loading", {}, "Loading models from the provider...");
    try {
      const result = await transport.discoverCustomProviderModels(
        value.baseUrl,
        value.api,
        value.apiKey,
      );
      const models = Array.isArray(result?.models) ? result.models : [];
      if (!models.length) throw new Error("The provider returned no models");
      modelsInput.value = models.join("\n");
      showStatus(
        "customProviders.loaded",
        { count: models.length },
        `Loaded ${models.length} models. Remove any you do not want to show.`,
        "success",
      );
    } catch (error) {
      showRawStatus(error?.message || t("customProviders.failed", {}, "Model discovery failed"));
    } finally {
      setBusy(false);
    }
  });

  saveButton.addEventListener("click", async () => {
    const value = values();
    if (!hasConnectionFields(value)) {
      showStatus(
        "customProviders.required",
        {},
        "Complete the provider name, ID, Base URL, and API Key first.",
        "error",
      );
      return;
    }
    if (!value.modelIds.length) {
      showStatus(
        "customProviders.modelsRequired",
        {},
        "Load or enter at least one model ID.",
        "error",
      );
      return;
    }
    setBusy(true);
    showStatus("customProviders.saving", {}, "Saving provider...");
    try {
      await transport.saveCustomProvider(value);
      apiKeyInput.value = "";
      showStatus(
        "customProviders.saved",
        {},
        "Provider saved. Its models are now available in chat.",
        "success",
      );
      await onChanged(value.providerId);
    } catch (error) {
      showRawStatus(
        error?.message || t("customProviders.failed", {}, "The provider could not be saved."),
      );
    } finally {
      setBusy(false);
    }
  });

  window.addEventListener("picot:locale-changed", () => {
    if (statusMessage) {
      if (statusMessage.raw) {
        showRawStatus(statusMessage.raw, statusMessage.kind);
      } else {
        const { id, variables, fallback, kind } = statusMessage;
        showStatus(id, variables, fallback, kind);
      }
    }
  });

  return { parseModelIds };
}

export { parseModelIds, slugifyProviderId };
