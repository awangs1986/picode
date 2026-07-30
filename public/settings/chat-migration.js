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

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: amount < 10 ? 1 : 0,
  }).format(amount);
  return `${formatted} ${unit}`;
}

function candidateTime(candidate) {
  const value = Date.parse(candidate.updatedAt || candidate.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

export function setupChatMigration({ transport, onImported = async () => {} }) {
  const section = document.getElementById("settings-chat-migration-section");
  const sources = document.getElementById("chat-migration-sources");
  const scanButton = document.getElementById("chat-migration-scan");
  const status = document.getElementById("chat-migration-status");
  const reviewControls = document.getElementById("chat-migration-review-controls");
  const sortControl = document.getElementById("chat-migration-sort");
  const sourceFilter = document.getElementById("chat-migration-source-filter");
  const archiveFilter = document.getElementById("chat-migration-archive-filter");
  const results = document.getElementById("chat-migration-results");
  const actions = document.getElementById("chat-migration-actions");
  const selection = document.getElementById("chat-migration-selection");
  const importButton = document.getElementById("chat-migration-import");
  const includeReasoning = document.getElementById("chat-migration-include-reasoning");
  if (!section || !sources || !scanButton || !status || !results || !actions || !importButton) {
    return { scan: async () => null };
  }

  let currentScan = null;
  let busy = false;
  const selectedCandidates = new Set();
  if (archiveFilter) archiveFilter.value = "active";

  function selectedIds() {
    if (!currentScan) return [];
    return currentScan.candidates
      .filter((candidate) => selectedCandidates.has(candidate.id))
      .map((candidate) => candidate.id);
  }

  function showStatus(message, kind = "info") {
    status.hidden = !message;
    status.textContent = message || "";
    status.dataset.kind = kind;
  }

  function setBusy(value) {
    busy = value;
    scanButton.disabled = value;
    for (const input of section.querySelectorAll("input, button, select")) {
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
    const row = element("div", "chat-migration-candidate");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("data-chat-candidate", candidate.id);
    input.setAttribute("aria-label", candidate.title);
    input.checked = selectedCandidates.has(candidate.id);

    const info = element("span", "chat-migration-candidate-info");
    const heading = element("span", "chat-migration-candidate-heading");
    heading.appendChild(element("span", "chat-migration-candidate-title", candidate.title));
    if (candidate.archived) {
      heading.appendChild(
        element("span", "chat-migration-archive-badge", t("common.archived", {}, "Archived")),
      );
    }
    const snippet = element(
      "span",
      "chat-migration-candidate-snippet",
      candidate.lastMessageSnippet ||
        t("chatMigration.previewUnavailable", {}, "No readable message preview."),
    );
    const metaParts = [sourceName(candidate.source)];
    if (candidate.updatedAt) {
      const formatted = formatDate(candidate.updatedAt, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      metaParts.push(t("chatMigration.updatedAt", { time: formatted }, `Updated ${formatted}`));
    }
    const size = formatBytes(candidate.fileSizeBytes);
    const meta = element("span", "chat-migration-candidate-meta", metaParts.join(" · "));
    meta.append(
      document.createTextNode(" · "),
      element(
        "span",
        "chat-migration-candidate-size",
        t("chatMigration.size", { size }, `Data ${size}`),
      ),
    );
    info.append(heading, snippet, meta);
    const viewButton = element(
      "button",
      "chat-migration-context-button",
      t("chatMigration.viewContext", {}, "View context"),
    );
    viewButton.type = "button";
    viewButton.setAttribute("data-chat-context", candidate.id);
    viewButton.setAttribute(
      "aria-label",
      t(
        "chatMigration.viewContextFor",
        { title: candidate.title },
        `View full context for ${candidate.title}`,
      ),
    );
    viewButton.addEventListener("click", async () => {
      if (!currentScan || busy) return;
      viewButton.disabled = true;
      try {
        await transport.openChatMigrationContext(currentScan.scanId, candidate.id);
      } catch (error) {
        showStatus(
          error?.message ||
            t("chatMigration.contextOpenFailed", {}, "Could not open the chat context."),
          "error",
        );
      } finally {
        viewButton.disabled = false;
      }
    });
    row.append(input, info, viewButton);
    return row;
  }

  function compareCandidates(left, right) {
    const mode = sortControl?.value || "updated-desc";
    const ascending = mode.endsWith("-asc");
    const leftValue = mode.startsWith("size")
      ? Number(left.fileSizeBytes) || 0
      : candidateTime(left);
    const rightValue = mode.startsWith("size")
      ? Number(right.fileSizeBytes) || 0
      : candidateTime(right);
    if (leftValue !== rightValue) {
      return ascending ? leftValue - rightValue : rightValue - leftValue;
    }
    return left.title.localeCompare(right.title);
  }

  function candidateVisible(candidate) {
    const source = sourceFilter?.value || "all";
    if (source !== "all" && candidate.source !== source) return false;
    const filter = archiveFilter?.value || "active";
    if (filter === "archived") return Boolean(candidate.archived);
    if (filter === "active") return !candidate.archived;
    return true;
  }

  function renderScan() {
    results.replaceChildren();
    if (!currentScan) {
      delete results.dataset.chatScanId;
      results.hidden = true;
      actions.hidden = true;
      if (reviewControls) reviewControls.hidden = true;
      return;
    }
    results.dataset.chatScanId = currentScan.scanId;

    for (const warning of currentScan.warnings || []) {
      results.appendChild(element("div", "chat-migration-warning", warning));
    }
    if (!currentScan.candidates?.length) {
      results.appendChild(
        element("div", "settings-api-keys-empty", t("chatMigration.none", {}, "No chats found.")),
      );
      results.hidden = false;
      actions.hidden = true;
      if (reviewControls) reviewControls.hidden = true;
      return;
    }
    if (reviewControls) reviewControls.hidden = false;

    const candidatesByGroup = new Map();
    for (const candidate of currentScan.candidates.filter(candidateVisible)) {
      const grouped = candidatesByGroup.get(candidate.workspaceGroupId) || [];
      grouped.push(candidate);
      candidatesByGroup.set(candidate.workspaceGroupId, grouped);
    }

    const visibleGroups = (currentScan.workspaceGroups || [])
      .map((group) => ({
        group,
        candidates: (candidatesByGroup.get(group.id) || []).sort(compareCandidates),
      }))
      .filter(({ candidates }) => candidates.length > 0)
      .sort(
        (left, right) =>
          compareCandidates(left.candidates[0], right.candidates[0]) ||
          displayWorkspace(left.group).localeCompare(displayWorkspace(right.group)),
      );
    if (visibleGroups.length === 0) {
      results.appendChild(
        element(
          "div",
          "settings-api-keys-empty",
          t("chatMigration.noFilterResults", {}, "No chats match this filter."),
        ),
      );
    }

    for (const { group, candidates } of visibleGroups) {
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
    selectedCandidates.clear();
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
      const result = await transport.importLocalChats(currentScan.scanId, candidateIds, bindings, {
        includeReasoning: Boolean(includeReasoning?.checked),
      });
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
      selectedCandidates.clear();
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
  results.addEventListener("change", (event) => {
    const input = event.target.closest?.("[data-chat-candidate]");
    if (input) {
      const id = input.getAttribute("data-chat-candidate");
      if (input.checked) selectedCandidates.add(id);
      else selectedCandidates.delete(id);
    }
    updateSelection();
  });
  sortControl?.addEventListener("change", renderScan);
  sourceFilter?.addEventListener("change", renderScan);
  archiveFilter?.addEventListener("change", renderScan);
  window.addEventListener("picot:locale-changed", () => renderScan());
  updateSelection();
  return { scan, importSelected };
}
