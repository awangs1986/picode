async function switchToWorkspace({
  targetCwd,
  tauriNative,
  fetchInstances,
  getCurrentPort,
  navigate,
  onInWindowNewSession,
}) {
  const instances = await fetchInstances();
  const currentPort = getCurrentPort();
  const current = instances.find((i) => i.port === currentPort);

  if (current && current.cwd === targetCwd) {
    await tauriNative.newSession();
    if (onInWindowNewSession) await onInWindowNewSession();
    return { samePort: true, port: currentPort };
  }

  const existing = instances.find((i) => i.cwd === targetCwd);
  let targetPort = existing?.port;

  if (targetPort) {
    await tauriNative.newSession(targetPort);
  } else {
    targetPort = await tauriNative.openWorkspace(targetCwd, {
      forceNewSession: true,
      openWindow: false,
      waitForSessions: false,
    });
  }

  navigate(`http://localhost:${targetPort}/`);
  return { samePort: false, port: targetPort };
}

export async function startInWindowNewSession({ tauriNative, renderError }) {
  if (!tauriNative) {
    renderError('New session is only supported in Tauri mode.');
    return false;
  }
  try {
    await tauriNative.newSession();
    return true;
  } catch (e) {
    renderError(`Failed to start new session: ${e}`);
    return false;
  }
}

export async function startNewProjectChat({
  project,
  tauriNative,
  fetchInstances,
  getCurrentPort,
  navigate,
  onInWindowNewSession,
  renderError,
}) {
  if (!tauriNative) {
    renderError('Project new chat is only supported in Tauri mode.');
    return false;
  }

  const targetCwd = project?.sessions?.find((session) => session?.cwd)?.cwd || project?.path;
  if (!targetCwd) {
    renderError('Failed to start new chat: project path is unavailable');
    return false;
  }

  try {
    await switchToWorkspace({
      targetCwd,
      tauriNative,
      fetchInstances,
      getCurrentPort,
      navigate,
      onInWindowNewSession,
    });
    return true;
  } catch (e) {
    renderError(`Failed to start new chat: ${e}`);
    return false;
  }
}

export async function openFolderAsWorkspace({
  tauriNative,
  fetchInstances,
  getCurrentPort,
  navigate,
  onInWindowNewSession,
  renderError,
}) {
  if (!tauriNative) {
    renderError('Open folder is only supported in Tauri mode.');
    return false;
  }

  try {
    const selectedPath = await tauriNative.pickFolder();
    if (!selectedPath) return false;

    await switchToWorkspace({
      targetCwd: selectedPath,
      tauriNative,
      fetchInstances,
      getCurrentPort,
      navigate,
      onInWindowNewSession,
    });
    return true;
  } catch (e) {
    renderError(`Failed to open folder: ${e}`);
    return false;
  }
}
