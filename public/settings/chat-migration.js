import { formatDate, t } from "../i18n/index.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sourceName(source) {
  return { codex: "Codex", cursor: "Cursor", claude: "Claude" }[source] || source;
}

function displayWorkspace(group) {
  return (
    group.originalWorkspace ||
    t("chatMigration.workspaceUnknown", {}, "Original workspace was not recorded")
  );
}

export function setupChatMigration({ transport, onImported = async () => {} }) {
  const section = document.getElementById("settings-chat-migration-section");
  const sources = document.getElementById("chat-migration-sources");
  const scanButton = document.getElementById("chat-migration-scan");
  const status = document.getElementById("chat-migration-status");
  const results = document.getElementById("chat-migration-results");
  const actions = document.getElementById("chat-migration-actions");
  const selection = document.getElementById("chat-migration-selection");
  const importButton = document.getElementById("chat-migration-import");
  if (!section || !sources || !scanButton || !status || !results || !actions || !importButton) {
    return { scan: async () => null };
  }

  let currentScan = null;
  let busy = false;

  function selectedIds() {
    return Array.from(results.querySelectorAll("[data-chat-candidate]:checked"), (input) =>
      input.getAttribute("data-chat-candidate"),
    );
  }

  function showStatus(message, kind = "info") {
    status.hidden = !message;
    status.textContent = message || "";
    status.dataset.kind = kind;
  }

  function setBusy(value) {
    busy = value;
    scanButton.disabled = value;
    for (const input of section.querySelectorAll("input, button")) {
      if (input !== scanButton) input.disabled = value;
    }
    if (!value) updateSelection();
  }

  function updateSelection() {
    const count = selectedIds().length;
    selection.textContent = t("chatMigration.selectedCount", { count }, `${count} chats selected`);
    importButton.disabled = busy || count === 0;
  }

  function candidateRow(candidate) {
    const label = element("label", "chat-migration-candidate");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("data-chat-candidate", candidate.id);
    input.setAttribute("aria-label", candidate.title);

    const info = element("span", "chat-migration-candidate-info");
    info.appendChild(element("span", "chat-migration-candidate-title", candidate.title));
    const metaParts = [sourceName(candidate.source)];
    if (candidate.updatedAt) {
      metaParts.push(formatDate(candidate.updatedAt, { dateStyle: "medium", timeStyle: "short" }));
    }
    info.appendChild(element("span", "chat-migration-candidate-meta", metaParts.join(" · ")));
    if (candidate.archived) {
      info.appendChild(
        element("span", "chat-migration-archive-badge", t("common.archived", {}, "Archived")),
      );
    }
    label.append(input, info);
    return label;
  }

  function renderScan() {
    results.replaceChildren();
    if (!currentScan) {
      results.hidden = true;
      actions.hidden = true;
      return;
    }

    for (const warning of currentScan.warnings || []) {
      results.appendChild(element("div", "chat-migration-warning", warning));
    }
    if (!currentScan.candidates?.length) {
      results.appendChild(
        element("div", "settings-api-keys-empty", t("chatMigration.none", {}, "No chats found.")),
      );
      results.hidden = false;
      actions.hidden = true;
      return;
    }

    const candidatesByGroup = new Map();
    for (const candidate of currentScan.candidates) {
      const grouped = candidatesByGroup.get(candidate.workspaceGroupId) || [];
      grouped.push(candidate);
      candidatesByGroup.set(candidate.workspaceGroupId, grouped);
    }

    for (const group of currentScan.workspaceGroups || []) {
      const candidates = candidatesByGroup.get(group.id) || [];
      if (candidates.length === 0) continue;
      const card = element("section", "chat-migration-workspace");
      const heading = element("div", "chat-migration-workspace-heading");
      const title = element("div", "chat-migration-workspace-title", displayWorkspace(group));
      title.title = displayWorkspace(group);
      heading.append(
        title,
        element(
          "span",
          "chat-migration-workspace-count",
          t("chatMigration.groupCount", { count: candidates.length }, `${candidates.length} chats`),
        ),
      );
      const hint = element(
        "p",
        "chat-migration-workspace-hint",
        t(
          "chatMigration.bindingHint",
          {},
          "When importing, choose one existing local folder for this workspace group.",
        ),
      );
      const list = element("div", "chat-migration-candidate-list");
      for (const candidate of candidates) list.appendChild(candidateRow(candidate));
      card.append(heading, hint, list);
      results.appendChild(card);
    }
    results.hidden = false;
    actions.hidden = false;
    updateSelection();
  }

  async function scan() {
    const requestedSources = Array.from(
      sources.querySelectorAll('input[type="checkbox"]:checked'),
      (input) => input.value,
    );
    if (requestedSources.length === 0) {
      showStatus(t("chatMigration.chooseSource", {}, "Select at least one chat source."), "error");
      return null;
    }
    setBusy(true);
    currentScan = null;
    renderScan();
    showStatus(t("chatMigration.scanning", {}, "Scanning local chat history..."));
    try {
      currentScan = await transport.scanLocalChats(requestedSources);
      renderScan();
      showStatus(
        t(
          "chatMigration.scanComplete",
          { count: currentScan.candidates?.length || 0 },
          `Found ${currentScan.candidates?.length || 0} chats. Select only the chats to import.`,
        ),
        "success",
      );
      return currentScan;
    } catch (error) {
      showStatus(
        error?.message || t("chatMigration.scanFailed", {}, "Could not scan local chats."),
        "error",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function chooseWorkspaceBindings(candidateIds) {
    const selected = new Set(candidateIds);
    const groupIds = new Set(
      currentScan.candidates
        .filter((candidate) => selected.has(candidate.id))
        .map((candidate) => candidate.workspaceGroupId),
    );
    const bindings = {};
    for (const group of currentScan.workspaceGroups) {
      if (!groupIds.has(group.id)) continue;
      showStatus(
        t(
          "chatMigration.chooseWorkspace",
          { workspace: displayWorkspace(group) },
          `Choose a current local folder for: ${displayWorkspace(group)}`,
        ),
      );
      const target = await transport.pickFolder();
      if (!target) return null;
      bindings[group.id] = target;
    }
    return bindings;
  }

  async function importSelected() {
    if (!currentScan) return null;
    const candidateIds = selectedIds();
    if (candidateIds.length === 0) return null;
    setBusy(true);
    try {
      const bindings = await chooseWorkspaceBindings(candidateIds);
      if (!bindings) {
        showStatus(t("chatMigration.cancelled", {}, "Import cancelled. No chats were changed."));
        return null;
      }
      showStatus(t("chatMigration.importing", {}, "Importing selected chats..."));
      const result = await transport.importLocalChats(currentScan.scanId, candidateIds, bindings);
      await onImported(result);
      showStatus(
        t(
          "chatMigration.imported",
          { imported: result.imported, skipped: result.skipped },
          `Imported ${result.imported} chats; skipped ${result.skipped} already imported chats.`,
        ),
        "success",
      );
      for (const input of results.querySelectorAll("[data-chat-candidate]:checked")) {
        input.checked = false;
      }
      return result;
    } catch (error) {
      showStatus(
        error?.message || t("chatMigration.importFailed", {}, "Could not import the chats."),
        "error",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  scanButton.addEventListener("click", () => void scan());
  importButton.addEventListener("click", () => void importSelected());
  results.addEventListener("change", updateSelection);
  window.addEventListener("picot:locale-changed", () => renderScan());
  updateSelection();
  return { scan, importSelected };
}
