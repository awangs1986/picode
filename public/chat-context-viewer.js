import { formatDate, t } from "./i18n/index.js";

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
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: amount < 10 ? 1 : 0 }).format(amount)} ${unit}`;
}

function recordCategory(record) {
  if (record.kind === "reasoning") return "reasoning";
  if (record.kind === "toolCall" || record.kind === "toolResult") return "tool";
  if (record.kind === "system" || record.kind === "summary" || record.role === "system") {
    return "system";
  }
  return record.role === "user" ? "user" : "assistant";
}

function recordLabel(record) {
  if (record.kind === "reasoning") return t("chatContext.reasoning", {}, "Reasoning");
  if (record.kind === "toolCall") return t("chatContext.toolCall", {}, "Tool call");
  if (record.kind === "toolResult") return t("chatContext.toolResult", {}, "Tool result");
  if (record.kind === "summary") return t("chatContext.summary", {}, "Compacted summary");
  if (record.role === "user") return t("chatContext.user", {}, "You");
  if (record.role === "assistant") return t("chatContext.assistant", {}, "Assistant");
  return t("chatContext.system", {}, "System");
}

export function createContextRecord(record, doc = document) {
  const category = recordCategory(record);
  const collapsible = category === "reasoning" || category === "tool" || category === "system";
  const container = doc.createElement(collapsible ? "details" : "article");
  container.className = `context-record context-record--${category}`;
  container.dataset.contextCategory = category;
  if (collapsible) container.open = false;

  const header = doc.createElement(collapsible ? "summary" : "div");
  header.className = collapsible ? "context-record-summary" : "context-record-header";
  const label = doc.createElement("strong");
  label.textContent = recordLabel(record);
  header.appendChild(label);
  if (record.toolName) {
    const tool = doc.createElement("span");
    tool.textContent = record.toolName;
    header.appendChild(tool);
  }
  if (record.model) {
    const model = doc.createElement("span");
    model.textContent = record.model;
    header.appendChild(model);
  }
  if (record.timestamp) {
    const formatted = formatDate(record.timestamp, { dateStyle: "medium", timeStyle: "medium" });
    if (formatted) {
      const timestamp = doc.createElement("time");
      timestamp.dateTime = record.timestamp;
      timestamp.textContent = formatted;
      header.appendChild(timestamp);
    }
  }

  const content = doc.createElement("pre");
  content.className = "context-record-content";
  content.textContent = record.content || "";
  container.append(header, content);
  return container;
}

export function setupChatContextViewer({ transport, env = window, root = document }) {
  const params = new URLSearchParams(env.location.search);
  const scanId = params.get("scanId") || "";
  const candidateId = params.get("candidateId") || "";
  const title = root.getElementById("context-title");
  const source = root.getElementById("context-source");
  const meta = root.getElementById("context-meta");
  const messages = root.getElementById("context-messages");
  const empty = root.getElementById("context-empty");
  const loadButton = root.getElementById("context-load-more");
  const status = root.getElementById("context-status");
  let cursor = null;
  let loaded = 0;
  let complete = false;
  let busy = false;
  let candidate = null;

  function renderCandidate(nextCandidate) {
    candidate = nextCandidate || candidate;
    if (!candidate) return;
    source.textContent = String(candidate.source || "Picode").replace(/^./, (char) =>
      char.toUpperCase(),
    );
    title.textContent = candidate.title || t("chatContext.windowTitle", {}, "Chat context");
    root.title = `Picode · ${title.textContent}`;
    const parts = [];
    if (candidate.originalWorkspace) {
      parts.push(
        t(
          "chatContext.workspace",
          { workspace: candidate.originalWorkspace },
          `Workspace: ${candidate.originalWorkspace}`,
        ),
      );
    }
    if (candidate.updatedAt) {
      const formatted = formatDate(candidate.updatedAt, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      if (formatted)
        parts.push(t("chatContext.updated", { time: formatted }, `Updated ${formatted}`));
    }
    if (candidate.archived) parts.push(t("common.archived", {}, "Archived"));
    parts.push(
      t(
        "chatContext.dataSize",
        { size: formatBytes(candidate.fileSizeBytes) },
        `Source data ${formatBytes(candidate.fileSizeBytes)}`,
      ),
    );
    meta.replaceChildren(
      ...parts.map((part) => {
        const item = root.createElement("span");
        item.textContent = part;
        return item;
      }),
    );
  }

  function updateStatus() {
    empty.hidden = loaded > 0 || !complete;
    if (!empty.hidden) {
      empty.textContent = t(
        "chatContext.noRecords",
        {},
        "No readable conversation records were found.",
      );
    }
    loadButton.hidden = complete;
    status.textContent = complete
      ? t("chatContext.complete", {}, "Complete conversation loaded")
      : t("chatContext.loadedCount", { count: loaded }, `${loaded} context records loaded`);
  }

  async function loadNext() {
    if (busy || complete || !scanId || !candidateId) return null;
    busy = true;
    loadButton.disabled = true;
    loadButton.textContent = t("chatContext.loading", {}, "Loading conversation context...");
    try {
      const page = await transport.readChatMigrationContext(scanId, candidateId, cursor);
      renderCandidate(page.candidate);
      for (const record of page.records || []) {
        messages.prepend(createContextRecord(record, root));
        loaded += 1;
      }
      cursor = page.nextCursor || null;
      complete = Boolean(page.complete || !cursor);
      updateStatus();
      return page;
    } catch (error) {
      status.textContent =
        error?.message || t("chatContext.failed", {}, "Could not read this conversation.");
      loadButton.hidden = false;
      loadButton.textContent = t("chatContext.retry", {}, "Retry");
      return null;
    } finally {
      busy = false;
      loadButton.disabled = false;
      if (!complete && loadButton.textContent !== t("chatContext.retry", {}, "Retry")) {
        loadButton.textContent = t("chatContext.loadMore", {}, "Load more");
      }
    }
  }

  loadButton.addEventListener("click", () => void loadNext());

  if (!scanId || !candidateId) {
    title.textContent = t("chatContext.windowTitle", {}, "Chat context");
    status.textContent = t(
      "chatContext.invalidLink",
      {},
      "This context link is incomplete. Scan local chats again.",
    );
    loadButton.hidden = true;
  } else {
    void loadNext();
  }

  return { loadNext };
}
