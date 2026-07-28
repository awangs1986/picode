import { formatDate, formatNumber, t } from "../i18n/index.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  return `${formatNumber(bytes / 1024, { maximumFractionDigits: 1 })} KB`;
}

function selectedIds(container) {
  return Array.from(
    container.querySelectorAll("[data-context-candidate]:checked"),
    (input) => input.dataset.contextCandidate,
  );
}

export function setupContextCompression({
  transport,
  getSelectedModel = () => ({ provider: "", modelId: "" }),
}) {
  const section = document.getElementById("settings-context-compression-section");
  const scanButton = document.getElementById("context-compression-scan");
  const status = document.getElementById("context-compression-status");
  const results = document.getElementById("context-compression-results");
  const actions = document.getElementById("context-compression-actions");
  const selection = document.getElementById("context-compression-selection");
  const reviewButton = document.getElementById("context-compression-review");
  const reviewPanel = document.getElementById("context-compression-review-panel");
  const reviewMeta = document.getElementById("context-compression-review-meta");
  const reviewSources = document.getElementById("context-compression-review-sources");
  const encrypted = document.getElementById("context-compression-encrypted");
  const passwords = document.getElementById("context-compression-passwords");
  const password = document.getElementById("context-compression-password");
  const passwordConfirm = document.getElementById("context-compression-password-confirm");
  const plaintextWarning = document.getElementById("context-compression-plaintext-warning");
  const createButton = document.getElementById("context-compression-create");
  if (!section || !scanButton || !results || !reviewPanel) return { scan: async () => null };

  let scanResult = null;
  let reviewResult = null;
  let busy = false;

  function showStatus(message, kind = "info") {
    status.hidden = !message;
    status.textContent = message || "";
    status.dataset.kind = kind;
  }

  function setBusy(value) {
    busy = value;
    for (const control of section.querySelectorAll("button, input")) control.disabled = value;
    if (!value) updateSelection();
  }

  function updateSelection() {
    const count = selectedIds(results).length;
    selection.textContent = t(
      "contextCompression.selectedCount",
      { count },
      `${count} chats selected`,
    );
    reviewButton.disabled = busy || count === 0;
  }

  function updateEncryption() {
    passwords.hidden = !encrypted.checked;
    plaintextWarning.hidden = encrypted.checked;
  }

  function renderScan() {
    results.replaceChildren();
    reviewPanel.hidden = true;
    reviewResult = null;
    if (!scanResult?.candidates?.length) {
      results.append(
        element(
          "div",
          "settings-api-keys-empty",
          t("contextCompression.none", {}, "No Picot chats found."),
        ),
      );
      results.hidden = false;
      actions.hidden = true;
      return;
    }
    const grouped = new Map();
    for (const candidate of scanResult.candidates) {
      const items = grouped.get(candidate.workspaceGroupId) || [];
      items.push(candidate);
      grouped.set(candidate.workspaceGroupId, items);
    }
    for (const group of scanResult.workspaceGroups) {
      const candidates = grouped.get(group.id) || [];
      if (!candidates.length) continue;
      const card = element("section", "chat-backup-workspace");
      const heading = element("div", "chat-backup-workspace-heading");
      const workspace = element("div", "chat-backup-workspace-title", group.workspacePath);
      workspace.title = group.workspacePath;
      heading.append(
        workspace,
        element(
          "span",
          "chat-backup-workspace-count",
          t(
            "contextCompression.groupCount",
            { count: candidates.length },
            `${candidates.length} chats`,
          ),
        ),
      );
      const list = element("div", "chat-backup-candidate-list");
      for (const candidate of candidates) {
        const label = element("label", "chat-backup-candidate");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.contextCandidate = candidate.id;
        input.setAttribute("aria-label", candidate.title);
        const info = element("span", "chat-backup-candidate-info");
        const metadata = [formatBytes(candidate.sizeBytes)];
        if (candidate.updatedAt) {
          metadata.push(
            formatDate(candidate.updatedAt, { dateStyle: "medium", timeStyle: "short" }),
          );
        }
        info.append(
          element("span", "chat-backup-candidate-title", candidate.title),
          element("span", "chat-backup-candidate-meta", metadata.join(" · ")),
        );
        label.append(input, info);
        list.append(label);
      }
      card.append(heading, list);
      results.append(card);
    }
    results.hidden = false;
    actions.hidden = false;
    updateSelection();
  }

  async function scan() {
    setBusy(true);
    showStatus(t("contextCompression.scanning", {}, "Loading Picot chats..."));
    try {
      scanResult = await transport.scanBackupSessions();
      renderScan();
      showStatus(
        t(
          "contextCompression.loaded",
          { count: scanResult.candidates?.length || 0 },
          `Loaded ${scanResult.candidates?.length || 0} chats. Nothing is sent yet.`,
        ),
        "success",
      );
      return scanResult;
    } catch (error) {
      showStatus(
        error?.message || t("contextCompression.scanFailed", {}, "Could not load Picot chats."),
        "error",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  function renderReview() {
    const model = `${reviewResult.provider}/${reviewResult.modelId}`;
    reviewMeta.textContent = t(
      "contextCompression.reviewMeta",
      {
        count: reviewResult.chats.length,
        model,
        tokens: formatNumber(reviewResult.estimatedInputTokens),
        redacted: formatNumber(reviewResult.redactedCredentialLines),
      },
      `${reviewResult.chats.length} chats · ${model} · about ${formatNumber(reviewResult.estimatedInputTokens)} input tokens`,
    );
    reviewSources.replaceChildren();
    for (const chat of reviewResult.chats) {
      const item = element("li", "context-compression-review-source");
      item.append(
        element("span", "chat-backup-candidate-title", chat.title),
        element("span", "chat-backup-candidate-meta", chat.workspacePath),
      );
      reviewSources.append(item);
    }
    encrypted.checked = true;
    updateEncryption();
    reviewPanel.hidden = false;
  }

  async function review() {
    if (!scanResult) return null;
    const candidateIds = selectedIds(results);
    if (!candidateIds.length) return null;
    const model = getSelectedModel() || {};
    if (!model.provider || !model.modelId) {
      showStatus(
        t(
          "contextCompression.noModel",
          {},
          "Choose a model in the chat window before reviewing compression.",
        ),
        "error",
      );
      return null;
    }
    setBusy(true);
    showStatus(
      t("contextCompression.preparingReview", {}, "Preparing the privacy review locally..."),
    );
    try {
      reviewResult = await transport.reviewContextCompression(
        scanResult.scanId,
        candidateIds,
        model.provider,
        model.modelId,
      );
      renderReview();
      showStatus(
        t(
          "contextCompression.reviewReady",
          {},
          "Review the sources and destination model. No model call has been made yet.",
        ),
        "success",
      );
      return reviewResult;
    } catch (error) {
      showStatus(
        error?.message ||
          t("contextCompression.reviewFailed", {}, "Could not prepare the compression review."),
        "error",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!reviewResult) return null;
    const shouldEncrypt = encrypted.checked;
    if (shouldEncrypt && password.value.length < 8) {
      showStatus(
        t("contextCompression.passwordLength", {}, "Use a password of at least 8 characters."),
        "error",
      );
      return null;
    }
    if (shouldEncrypt && password.value !== passwordConfirm.value) {
      showStatus(t("contextCompression.passwordMismatch", {}, "Passwords do not match."), "error");
      return null;
    }
    if (
      !shouldEncrypt &&
      !window.confirm(
        t(
          "contextCompression.plaintextConfirm",
          {},
          "Create an unencrypted compressed-context package?",
        ),
      )
    ) {
      return null;
    }
    setBusy(true);
    try {
      const destination = await transport.pickContextPackageSavePath();
      if (!destination) return null;
      showStatus(
        t("contextCompression.creating", {}, "The selected Pi model is compressing the chats..."),
      );
      const result = await transport.createContextPackage({
        reviewId: reviewResult.reviewId,
        encrypted: shouldEncrypt,
        password: password.value,
        destination,
      });
      reviewResult = null;
      reviewPanel.hidden = true;
      showStatus(
        t(
          "contextCompression.created",
          { count: result.memoryCount, path: result.path },
          `Saved ${result.memoryCount} durable memories to ${result.path}`,
        ),
        "success",
      );
      return result;
    } catch (error) {
      showStatus(
        error?.message ||
          t("contextCompression.createFailed", {}, "Could not create the context package."),
        "error",
      );
      return null;
    } finally {
      password.value = "";
      passwordConfirm.value = "";
      setBusy(false);
    }
  }

  scanButton.addEventListener("click", scan);
  results.addEventListener("change", updateSelection);
  reviewButton.addEventListener("click", review);
  encrypted.addEventListener("change", updateEncryption);
  createButton.addEventListener("click", create);
  updateEncryption();
  return { scan, review, create };
}
