import { formatDate, t } from "../i18n/index.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function accountStatus(account) {
  if (!account.chatCompatible) {
    return t("accounts.storedOnly", {}, "Stored only");
  }
  return account.active
    ? t("accounts.active", {}, "Active")
    : t("accounts.inactive", {}, "Stored, inactive");
}

function providerName(provider) {
  return { codex: "Codex", cursor: "Cursor", claude: "Claude" }[provider] || provider;
}

export function setupAccountSettings({ transport, onAccountsChanged = async () => {} }) {
  const section = document.getElementById("settings-accounts-section");
  const list = document.getElementById("account-vault-list");
  const status = document.getElementById("account-import-status");
  const previewPanel = document.getElementById("account-import-preview");
  const warningList = document.getElementById("account-import-warnings");
  const candidateList = document.getElementById("account-import-candidates");
  const confirmButton = document.getElementById("account-import-confirm");
  const cancelButton = document.getElementById("account-import-cancel");
  const fileInput = document.getElementById("account-json-file-input");
  if (!section || !list || !previewPanel || !candidateList || !fileInput) {
    return { loadAccounts: async () => {} };
  }

  let currentPreview = null;
  let jsonProvider = null;
  let accounts = [];

  function showStatus(message, kind = "info") {
    status.hidden = !message;
    status.textContent = message || "";
    status.dataset.kind = kind;
  }

  function hidePreview() {
    currentPreview = null;
    previewPanel.hidden = true;
    warningList.replaceChildren();
    candidateList.replaceChildren();
  }

  function renderAccounts() {
    list.replaceChildren();
    if (!accounts.length) {
      list.appendChild(
        element(
          "div",
          "settings-api-keys-empty",
          t("accounts.none", {}, "No imported accounts yet."),
        ),
      );
      return;
    }
    for (const account of accounts) {
      const row = element("div", "account-vault-row");
      row.classList.toggle("is-active", Boolean(account.active));
      const main = element("div", "account-vault-main");
      main.appendChild(element("div", "account-vault-name", account.label));
      const detail = element("div", "account-vault-detail");
      detail.appendChild(
        element(
          "span",
          "account-vault-provider",
          `${providerName(account.provider)} · ${account.authKind === "oauth" ? "OAuth" : "API Key"}`,
        ),
      );
      if (account.endpoint?.baseUrl) {
        detail.appendChild(element("span", "account-vault-endpoint", account.endpoint.baseUrl));
      }
      if (account.importedAt) {
        detail.appendChild(
          element(
            "span",
            "account-vault-date",
            formatDate(account.importedAt, { dateStyle: "medium", timeStyle: "short" }),
          ),
        );
      }
      main.appendChild(detail);
      const badge = element("span", "account-vault-status", accountStatus(account));
      badge.dataset.state = account.chatCompatible
        ? account.active
          ? "active"
          : "inactive"
        : "stored-only";
      row.append(main, badge);
      list.appendChild(row);
    }
  }

  async function loadAccounts() {
    if (!transport.capabilities.native) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    try {
      accounts = await transport.listAccounts();
      renderAccounts();
    } catch (error) {
      list.replaceChildren(
        element(
          "div",
          "settings-api-keys-empty",
          error?.message || t("accounts.loadFailed", {}, "Failed to load accounts."),
        ),
      );
    }
  }

  function renderPreview(preview) {
    currentPreview = preview;
    previewPanel.hidden = false;
    warningList.replaceChildren();
    candidateList.replaceChildren();
    for (const warning of preview.warnings || []) {
      warningList.appendChild(element("div", "account-import-warning", warning));
    }
    let activated = false;
    for (const candidate of preview.candidates) {
      const row = element("div", "account-import-candidate");
      const select = document.createElement("input");
      select.type = "checkbox";
      select.checked = true;
      select.dataset.candidateSelect = candidate.candidateId;

      const info = element("div", "account-import-candidate-info");
      info.appendChild(element("div", "account-import-candidate-name", candidate.label));
      info.appendChild(
        element(
          "div",
          "account-import-candidate-meta",
          `${providerName(candidate.provider)} · ${candidate.authKind === "oauth" ? "OAuth" : "API Key"}`,
        ),
      );
      for (const warning of candidate.warnings || []) {
        info.appendChild(element("div", "account-import-warning", warning));
      }

      const activation = element("label", "account-import-activate");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "account-import-activate";
      radio.value = candidate.candidateId;
      radio.disabled = !candidate.chatCompatible;
      if (!activated && candidate.chatCompatible) {
        radio.checked = true;
        activated = true;
      }
      activation.append(
        radio,
        ` ${
          candidate.chatCompatible
            ? t("accounts.activate", {}, "Use for new chats")
            : t("accounts.cannotActivate", {}, "Cannot use for Pi chat")
        }`,
      );
      row.append(select, info, activation);
      candidateList.appendChild(row);
    }
    previewPanel.scrollIntoView({ block: "nearest" });
  }

  async function previewLocal(provider, button) {
    button.disabled = true;
    hidePreview();
    showStatus(t("accounts.scanning", {}, "Reading the selected local account…"));
    try {
      renderPreview(await transport.previewLocalAccountImport(provider));
      showStatus("");
    } catch (error) {
      showStatus(
        error?.message || t("accounts.previewFailed", {}, "Import preview failed."),
        "error",
      );
    } finally {
      button.disabled = false;
    }
  }

  async function readJsonSelection(files) {
    const loaded = await Promise.all(
      files.map(async (file) => ({ name: file.name, content: await file.text() })),
    );
    if (loaded.length === 1) return loaded[0];
    const values = loaded.flatMap(({ content }) => {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [parsed];
    });
    return {
      name: loaded.map((file) => file.name).join(", "),
      content: JSON.stringify(values),
    };
  }

  async function previewJsonFiles() {
    const files = Array.from(fileInput.files || []);
    fileInput.value = "";
    if (!jsonProvider || files.length === 0) return;
    hidePreview();
    showStatus(t("accounts.readingJson", {}, "Reading selected JSON…"));
    try {
      const selected = await readJsonSelection(files);
      renderPreview(
        await transport.previewJsonAccountImport(jsonProvider, selected.content, selected.name),
      );
      showStatus("");
    } catch (error) {
      showStatus(
        error?.message || t("accounts.previewFailed", {}, "Import preview failed."),
        "error",
      );
    }
  }

  async function applyPreview() {
    if (!currentPreview) return;
    const selectedIds = Array.from(
      candidateList.querySelectorAll("[data-candidate-select]:checked"),
      (input) => input.dataset.candidateSelect,
    ).filter(Boolean);
    if (!selectedIds.length) {
      showStatus(t("accounts.selectOne", {}, "Select at least one account."), "error");
      return;
    }
    const active = candidateList.querySelector('input[name="account-import-activate"]:checked');
    confirmButton.disabled = true;
    showStatus(t("accounts.saving", {}, "Encrypting and saving selected accounts…"));
    try {
      const result = await transport.applyAccountImport(
        currentPreview.previewId,
        selectedIds,
        active?.value || null,
      );
      accounts = result.accounts || [];
      hidePreview();
      renderAccounts();
      showStatus(
        t(
          "accounts.saved",
          { count: result.importedIds?.length || selectedIds.length },
          `${selectedIds.length} account(s) imported.`,
        ),
        "success",
      );
      await onAccountsChanged(result);
    } catch (error) {
      showStatus(
        error?.message || t("accounts.saveFailed", {}, "Failed to save accounts."),
        "error",
      );
    } finally {
      confirmButton.disabled = false;
    }
  }

  for (const button of section.querySelectorAll("[data-account-local]")) {
    button.addEventListener("click", () => previewLocal(button.dataset.accountLocal, button));
  }
  for (const button of section.querySelectorAll("[data-account-json]")) {
    button.addEventListener("click", () => {
      jsonProvider = button.dataset.accountJson;
      fileInput.click();
    });
  }
  fileInput.addEventListener("change", () => void previewJsonFiles());
  cancelButton.addEventListener("click", hidePreview);
  confirmButton.addEventListener("click", () => void applyPreview());
  window.addEventListener("picot:locale-changed", () => {
    renderAccounts();
    if (currentPreview) renderPreview(currentPreview);
  });

  return { loadAccounts };
}
