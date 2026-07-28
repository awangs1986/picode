import { formatDate, formatNumber, t } from "../i18n/index.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function storageSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(bytes / 1024 / 1024, { maximumFractionDigits: 1 })} MB`;
}

function checkedIds(container, attribute) {
  return Array.from(container.querySelectorAll(`[${attribute}]:checked`), (input) =>
    input.getAttribute(attribute),
  );
}

function renderGroupCards({ container, groups, candidates, attribute, candidateMeta }) {
  container.replaceChildren();
  const byGroup = new Map();
  for (const candidate of candidates) {
    const grouped = byGroup.get(candidate.workspaceGroupId) || [];
    grouped.push(candidate);
    byGroup.set(candidate.workspaceGroupId, grouped);
  }
  for (const group of groups) {
    const grouped = byGroup.get(group.id) || [];
    if (grouped.length === 0) continue;
    const card = element("section", "chat-backup-workspace");
    const heading = element("div", "chat-backup-workspace-heading");
    const workspace = element("div", "chat-backup-workspace-title", group.workspacePath);
    workspace.title = group.workspacePath;
    heading.append(
      workspace,
      element(
        "span",
        "chat-backup-workspace-count",
        t("chatBackup.groupCount", { count: grouped.length }, `${grouped.length} chats`),
      ),
    );
    const list = element("div", "chat-backup-candidate-list");
    for (const candidate of grouped) {
      const label = element("label", "chat-backup-candidate");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute(attribute, candidate.id);
      input.setAttribute("aria-label", candidate.title);
      const info = element("span", "chat-backup-candidate-info");
      info.append(
        element("span", "chat-backup-candidate-title", candidate.title),
        element("span", "chat-backup-candidate-meta", candidateMeta(candidate)),
      );
      label.append(input, info);
      list.appendChild(label);
    }
    card.append(heading, list);
    container.appendChild(card);
  }
  container.hidden = false;
}

export function setupChatBackup({ transport, onRestored = async () => {} }) {
  const backupSection = document.getElementById("settings-chat-backup-section");
  const backupScanButton = document.getElementById("chat-backup-scan");
  const backupStatus = document.getElementById("chat-backup-status");
  const backupResults = document.getElementById("chat-backup-results");
  const backupOptions = document.getElementById("chat-backup-options");
  const backupEncrypted = document.getElementById("chat-backup-encrypted");
  const backupPasswords = document.getElementById("chat-backup-passwords");
  const backupPassword = document.getElementById("chat-backup-password");
  const backupPasswordConfirm = document.getElementById("chat-backup-password-confirm");
  const plaintextWarning = document.getElementById("chat-backup-plaintext-warning");
  const backupSelection = document.getElementById("chat-backup-selection");
  const backupCreateButton = document.getElementById("chat-backup-create");

  const restoreSection = document.getElementById("settings-chat-restore-section");
  const restoreOpenButton = document.getElementById("chat-restore-open");
  const restoreStatus = document.getElementById("chat-restore-status");
  const restoreVerify = document.getElementById("chat-restore-verify");
  const restoreMeta = document.getElementById("chat-restore-meta");
  const restorePasswordField = document.getElementById("chat-restore-password-field");
  const restorePassword = document.getElementById("chat-restore-password");
  const restoreInspectButton = document.getElementById("chat-restore-inspect");
  const restoreResults = document.getElementById("chat-restore-results");
  const restoreActions = document.getElementById("chat-restore-actions");
  const restoreSelection = document.getElementById("chat-restore-selection");
  const restoreApplyButton = document.getElementById("chat-restore-apply");
  if (
    !backupSection ||
    !backupScanButton ||
    !backupResults ||
    !backupOptions ||
    !restoreSection ||
    !restoreOpenButton ||
    !restoreResults
  ) {
    return { scan: async () => null, open: async () => null };
  }

  let backupScan = null;
  let backupBusy = false;
  let restorePath = null;
  let restoreProbe = null;
  let restorePreview = null;
  let restoreBusy = false;

  function showStatus(node, message, kind = "info") {
    node.hidden = !message;
    node.textContent = message || "";
    node.dataset.kind = kind;
  }

  function updateBackupEncryption() {
    const encrypted = backupEncrypted.checked;
    backupPasswords.hidden = !encrypted;
    plaintextWarning.hidden = encrypted;
  }

  function updateBackupSelection() {
    const count = checkedIds(backupResults, "data-backup-candidate").length;
    backupSelection.textContent = t(
      "chatBackup.selectedCount",
      { count },
      `${count} chats selected`,
    );
    backupCreateButton.disabled = backupBusy || count === 0;
  }

  function updateRestoreSelection() {
    const count = checkedIds(restoreResults, "data-restore-candidate").length;
    restoreSelection.textContent = t(
      "chatRestore.selectedCount",
      { count },
      `${count} chats selected`,
    );
    restoreApplyButton.disabled = restoreBusy || count === 0;
  }

  function setBackupBusy(value) {
    backupBusy = value;
    for (const control of backupSection.querySelectorAll("button, input")) control.disabled = value;
    if (!value) updateBackupSelection();
  }

  function setRestoreBusy(value) {
    restoreBusy = value;
    for (const control of restoreSection.querySelectorAll("button, input"))
      control.disabled = value;
    if (!value) updateRestoreSelection();
  }

  function renderBackupScan() {
    if (!backupScan?.candidates?.length) {
      backupResults.replaceChildren(
        element(
          "div",
          "settings-api-keys-empty",
          t("chatBackup.none", {}, "No Picot chats found."),
        ),
      );
      backupResults.hidden = false;
      backupOptions.hidden = true;
      return;
    }
    const archived = storageSet("pi-studio-archived");
    const favourites = storageSet("pi-studio-favourites");
    renderGroupCards({
      container: backupResults,
      groups: backupScan.workspaceGroups,
      candidates: backupScan.candidates,
      attribute: "data-backup-candidate",
      candidateMeta: (candidate) => {
        const metadata = [formatBytes(candidate.sizeBytes)];
        if (candidate.updatedAt) {
          metadata.push(
            formatDate(candidate.updatedAt, { dateStyle: "medium", timeStyle: "short" }),
          );
        }
        if (archived.has(candidate.sessionFile)) {
          metadata.push(t("common.archived", {}, "Archived"));
        }
        if (favourites.has(candidate.sessionFile)) {
          metadata.push(t("chatBackup.favourite", {}, "Favourite"));
        }
        return metadata.join(" · ");
      },
    });
    backupOptions.hidden = false;
    updateBackupEncryption();
    updateBackupSelection();
  }

  async function scan() {
    setBackupBusy(true);
    showStatus(backupStatus, t("chatBackup.scanning", {}, "Loading Picot chats..."));
    try {
      backupScan = await transport.scanBackupSessions();
      renderBackupScan();
      showStatus(
        backupStatus,
        t(
          "chatBackup.loaded",
          { count: backupScan.candidates?.length || 0 },
          `Loaded ${backupScan.candidates?.length || 0} chats. Select only the chats to back up.`,
        ),
        "success",
      );
      return backupScan;
    } catch (error) {
      showStatus(
        backupStatus,
        error?.message || t("chatBackup.scanFailed", {}, "Could not load Picot chats."),
        "error",
      );
      return null;
    } finally {
      setBackupBusy(false);
    }
  }

  async function createBackup() {
    if (!backupScan) return null;
    const candidateIds = checkedIds(backupResults, "data-backup-candidate");
    if (candidateIds.length === 0) return null;
    const encrypted = backupEncrypted.checked;
    const password = backupPassword.value;
    if (encrypted && password.length < 8) {
      showStatus(
        backupStatus,
        t("chatBackup.passwordLength", {}, "Use a password of at least 8 characters."),
        "error",
      );
      return null;
    }
    if (encrypted && password !== backupPasswordConfirm.value) {
      showStatus(
        backupStatus,
        t("chatBackup.passwordMismatch", {}, "Passwords do not match."),
        "error",
      );
      return null;
    }
    if (
      !encrypted &&
      !window.confirm(
        t(
          "chatBackup.plaintextConfirm",
          {},
          "Create an unencrypted backup containing full chat text?",
        ),
      )
    ) {
      return null;
    }
    setBackupBusy(true);
    try {
      const destination = await transport.pickBackupSavePath();
      if (!destination) {
        showStatus(backupStatus, t("chatBackup.cancelled", {}, "Backup cancelled."));
        return null;
      }
      const archived = storageSet("pi-studio-archived");
      const favourites = storageSet("pi-studio-favourites");
      const selected = new Set(candidateIds);
      const flags = {};
      for (const candidate of backupScan.candidates) {
        if (!selected.has(candidate.id)) continue;
        flags[candidate.id] = {
          archived: archived.has(candidate.sessionFile),
          favourite: favourites.has(candidate.sessionFile),
        };
      }
      showStatus(backupStatus, t("chatBackup.creating", {}, "Creating chat backup..."));
      const result = await transport.createChatBackup({
        scanId: backupScan.scanId,
        candidateIds,
        flags,
        encrypted,
        password,
        destination,
      });
      showStatus(
        backupStatus,
        t(
          "chatBackup.created",
          { count: result.chatCount, path: result.path },
          `Backed up ${result.chatCount} chats to ${result.path}`,
        ),
        "success",
      );
      return result;
    } catch (error) {
      showStatus(
        backupStatus,
        error?.message || t("chatBackup.createFailed", {}, "Could not create the backup."),
        "error",
      );
      return null;
    } finally {
      backupPassword.value = "";
      backupPasswordConfirm.value = "";
      setBackupBusy(false);
    }
  }

  function renderRestoreMeta() {
    if (!restoreProbe) return;
    const protection = restoreProbe.encrypted
      ? t("chatRestore.encrypted", {}, "Encrypted")
      : t("chatRestore.plaintext", {}, "Unencrypted");
    restoreMeta.textContent = t(
      "chatRestore.meta",
      {
        count: restoreProbe.chatCount,
        protection,
        date: formatDate(restoreProbe.createdAt, { dateStyle: "medium", timeStyle: "short" }),
      },
      `${restoreProbe.chatCount} chats · ${protection}`,
    );
  }

  async function open() {
    setRestoreBusy(true);
    try {
      const path = await transport.pickBackupOpenPath();
      if (!path) return null;
      showStatus(restoreStatus, t("chatRestore.reading", {}, "Reading backup manifest..."));
      restoreProbe = await transport.probeChatBackup(path);
      restorePath = path;
      restorePreview = null;
      restoreResults.hidden = true;
      restoreActions.hidden = true;
      restoreVerify.hidden = false;
      restorePasswordField.hidden = !restoreProbe.encrypted;
      renderRestoreMeta();
      showStatus(
        restoreStatus,
        restoreProbe.encrypted
          ? t("chatRestore.passwordRequired", {}, "Enter the backup password to verify it.")
          : t("chatRestore.readyToVerify", {}, "The backup is ready for full verification."),
      );
      return restoreProbe;
    } catch (error) {
      showStatus(
        restoreStatus,
        error?.message || t("chatRestore.openFailed", {}, "Could not open the backup."),
        "error",
      );
      return null;
    } finally {
      setRestoreBusy(false);
    }
  }

  function renderRestorePreview() {
    renderGroupCards({
      container: restoreResults,
      groups: restorePreview.workspaceGroups,
      candidates: restorePreview.chats,
      attribute: "data-restore-candidate",
      candidateMeta: (candidate) => {
        const metadata = [formatBytes(candidate.sizeBytes)];
        if (candidate.archived) metadata.push(t("common.archived", {}, "Archived"));
        if (candidate.favourite) metadata.push(t("chatBackup.favourite", {}, "Favourite"));
        return metadata.join(" · ");
      },
    });
    restoreActions.hidden = false;
    updateRestoreSelection();
  }

  async function inspect() {
    if (!restorePath) return null;
    setRestoreBusy(true);
    showStatus(restoreStatus, t("chatRestore.verifying", {}, "Verifying the complete backup..."));
    try {
      restorePreview = await transport.inspectChatBackup(restorePath, restorePassword.value);
      renderRestorePreview();
      showStatus(
        restoreStatus,
        t(
          "chatRestore.verified",
          { count: restorePreview.chats.length },
          `Verified ${restorePreview.chats.length} chats. Select only the chats to restore.`,
        ),
        "success",
      );
      return restorePreview;
    } catch (error) {
      showStatus(
        restoreStatus,
        error?.message || t("chatRestore.verifyFailed", {}, "Backup verification failed."),
        "error",
      );
      return null;
    } finally {
      restorePassword.value = "";
      setRestoreBusy(false);
    }
  }

  async function chooseRestoreBindings(candidateIds) {
    const selected = new Set(candidateIds);
    const groupIds = new Set(
      restorePreview.chats
        .filter((chat) => selected.has(chat.id))
        .map((chat) => chat.workspaceGroupId),
    );
    const bindings = {};
    for (const group of restorePreview.workspaceGroups) {
      if (!groupIds.has(group.id)) continue;
      showStatus(
        restoreStatus,
        t(
          "chatRestore.chooseWorkspace",
          { workspace: group.workspacePath },
          `Choose a current local folder for: ${group.workspacePath}`,
        ),
      );
      const target = await transport.pickFolder();
      if (!target) return null;
      bindings[group.id] = target;
    }
    return bindings;
  }

  async function restoreSelected() {
    if (!restorePreview) return null;
    const candidateIds = checkedIds(restoreResults, "data-restore-candidate");
    if (candidateIds.length === 0) return null;
    setRestoreBusy(true);
    try {
      const bindings = await chooseRestoreBindings(candidateIds);
      if (!bindings) {
        showStatus(
          restoreStatus,
          t("chatRestore.cancelled", {}, "Restore cancelled. No chats were changed."),
        );
        return null;
      }
      showStatus(restoreStatus, t("chatRestore.restoring", {}, "Restoring selected chats..."));
      const result = await transport.restoreChatBackup(
        restorePreview.restoreId,
        candidateIds,
        bindings,
      );
      await onRestored(result);
      showStatus(
        restoreStatus,
        t(
          "chatRestore.restored",
          { added: result.added, skipped: result.skipped, conflicted: result.conflicted },
          `Added ${result.added}, skipped ${result.skipped}, conflict copies ${result.conflicted}.`,
        ),
        "success",
      );
      return result;
    } catch (error) {
      showStatus(
        restoreStatus,
        error?.message || t("chatRestore.restoreFailed", {}, "Could not restore the backup."),
        "error",
      );
      return null;
    } finally {
      setRestoreBusy(false);
    }
  }

  backupScanButton.addEventListener("click", () => void scan());
  backupResults.addEventListener("change", updateBackupSelection);
  backupEncrypted.addEventListener("change", updateBackupEncryption);
  backupCreateButton.addEventListener("click", () => void createBackup());
  restoreOpenButton.addEventListener("click", () => void open());
  restoreInspectButton.addEventListener("click", () => void inspect());
  restoreResults.addEventListener("change", updateRestoreSelection);
  restoreApplyButton.addEventListener("click", () => void restoreSelected());
  window.addEventListener("picot:locale-changed", () => {
    if (backupScan) renderBackupScan();
    if (restoreProbe) renderRestoreMeta();
    if (restorePreview) renderRestorePreview();
  });
  updateBackupEncryption();
  updateBackupSelection();
  updateRestoreSelection();
  return { scan, createBackup, open, inspect, restoreSelected };
}
