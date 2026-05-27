import { describe, it, expect, vi } from 'vitest';
import {
  startNewProjectChat,
  openFolderAsWorkspace,
  startInWindowNewSession,
} from './workspace-actions.js';

function makeDeps({
  instances = [],
  currentPort = 3001,
  openWorkspacePort = 3099,
} = {}) {
  const tauriNative = {
    newSession: vi.fn().mockResolvedValue(undefined),
    openWorkspace: vi.fn().mockResolvedValue(openWorkspacePort),
    pickFolder: vi.fn().mockResolvedValue('/picked/path'),
  };
  const fetchInstances = vi.fn().mockResolvedValue(instances);
  const getCurrentPort = vi.fn().mockReturnValue(currentPort);
  const navigate = vi.fn();
  const onInWindowNewSession = vi.fn().mockResolvedValue(undefined);
  const renderError = vi.fn();
  return {
    tauriNative,
    fetchInstances,
    getCurrentPort,
    navigate,
    onInWindowNewSession,
    renderError,
  };
}

describe('startNewProjectChat', () => {
  it('issues an in-window new_session RPC when target cwd matches the current window', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/Users/me/proj', sessionFile: '' }],
      currentPort: 3001,
    });

    const result = await startNewProjectChat({
      project: { path: '/Users/me/proj', sessions: [{ cwd: '/Users/me/proj' }] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.newSession).toHaveBeenCalledTimes(1);
    expect(deps.tauriNative.newSession).toHaveBeenCalledWith();
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(deps.onInWindowNewSession).toHaveBeenCalledTimes(1);
    expect(deps.renderError).not.toHaveBeenCalled();
  });

  it('reuses an existing pi instance for a different cwd and navigates in the same window', async () => {
    const deps = makeDeps({
      instances: [
        { port: 3001, cwd: '/Users/me/proj', sessionFile: '' },
        { port: 3005, cwd: '/Users/me/other', sessionFile: '' },
      ],
      currentPort: 3001,
    });

    const result = await startNewProjectChat({
      project: { path: '/Users/me/other', sessions: [{ cwd: '/Users/me/other' }] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.newSession).toHaveBeenCalledWith(3005);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3005/');
    expect(deps.onInWindowNewSession).not.toHaveBeenCalled();
  });

  it('spawns a windowless pi when no instance exists for the target cwd, then navigates', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/Users/me/proj', sessionFile: '' }],
      currentPort: 3001,
      openWorkspacePort: 3010,
    });

    const result = await startNewProjectChat({
      project: { path: '/Users/me/fresh', sessions: [{ cwd: '/Users/me/fresh' }] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.newSession).not.toHaveBeenCalled();
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledWith('/Users/me/fresh', {
      forceNewSession: true,
      openWindow: false,
    });
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3010/');
    expect(deps.onInWindowNewSession).not.toHaveBeenCalled();
  });

  it('falls back to project path when a session cwd is missing', async () => {
    const deps = makeDeps({ instances: [], currentPort: 3001, openWorkspacePort: 3010 });

    const result = await startNewProjectChat({
      project: { path: '/project/path', sessions: [{ cwd: '' }] },
      ...deps,
    });

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledWith('/project/path', {
      forceNewSession: true,
      openWindow: false,
    });
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3010/');
  });

  it('renders error when tauri is unavailable', async () => {
    const deps = makeDeps();
    const result = await startNewProjectChat({
      project: { path: '/project/path', sessions: [] },
      ...deps,
      tauriNative: null,
    });

    expect(result).toBe(false);
    expect(deps.renderError).toHaveBeenCalledWith('Project new chat is only supported in Tauri mode.');
  });

  it('renders error when project path is unavailable', async () => {
    const deps = makeDeps();
    const result = await startNewProjectChat({
      project: { path: '', sessions: [] },
      ...deps,
    });

    expect(result).toBe(false);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.renderError.mock.calls[0][0]).toContain('Failed to start new chat:');
  });
});

describe('openFolderAsWorkspace', () => {
  it('issues an in-window new_session RPC when the picked folder matches the current window', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/picked/path', sessionFile: '' }],
      currentPort: 3001,
    });
    deps.tauriNative.pickFolder = vi.fn().mockResolvedValue('/picked/path');

    const result = await openFolderAsWorkspace(deps);

    expect(result).toBe(true);
    expect(deps.tauriNative.newSession).toHaveBeenCalledWith();
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(deps.onInWindowNewSession).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing pi instance for the picked folder and navigates in the same window', async () => {
    const deps = makeDeps({
      instances: [
        { port: 3001, cwd: '/Users/me/proj', sessionFile: '' },
        { port: 3005, cwd: '/picked/path', sessionFile: '' },
      ],
      currentPort: 3001,
    });

    const result = await openFolderAsWorkspace(deps);

    expect(result).toBe(true);
    expect(deps.tauriNative.newSession).toHaveBeenCalledWith(3005);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3005/');
  });

  it('spawns a windowless pi when no instance matches the picked folder, then navigates', async () => {
    const deps = makeDeps({
      instances: [{ port: 3001, cwd: '/Users/me/proj', sessionFile: '' }],
      currentPort: 3001,
      openWorkspacePort: 3010,
    });

    const result = await openFolderAsWorkspace(deps);

    expect(result).toBe(true);
    expect(deps.tauriNative.openWorkspace).toHaveBeenCalledWith('/picked/path', {
      forceNewSession: true,
      openWindow: false,
    });
    expect(deps.navigate).toHaveBeenCalledWith('http://localhost:3010/');
  });

  it('does nothing when folder picker is cancelled', async () => {
    const deps = makeDeps();
    deps.tauriNative.pickFolder = vi.fn().mockResolvedValue('');

    const result = await openFolderAsWorkspace(deps);

    expect(result).toBe(false);
    expect(deps.tauriNative.openWorkspace).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('renders error when tauri is unavailable', async () => {
    const deps = makeDeps();
    const result = await openFolderAsWorkspace({
      ...deps,
      tauriNative: null,
    });

    expect(result).toBe(false);
    expect(deps.renderError).toHaveBeenCalledWith('Open folder is only supported in Tauri mode.');
  });
});

describe('startInWindowNewSession', () => {
  it('invokes tauriNative.newSession for the current window', async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);

    const result = await startInWindowNewSession({
      tauriNative: { newSession },
      renderError: vi.fn(),
    });

    expect(result).toBe(true);
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('renders error when tauri is unavailable', async () => {
    const renderError = vi.fn();

    const result = await startInWindowNewSession({
      tauriNative: null,
      renderError,
    });

    expect(result).toBe(false);
    expect(renderError).toHaveBeenCalledWith('New session is only supported in Tauri mode.');
  });

  it('renders error when newSession throws', async () => {
    const renderError = vi.fn();
    const newSession = vi.fn().mockRejectedValue(new Error('boom'));

    const result = await startInWindowNewSession({
      tauriNative: { newSession },
      renderError,
    });

    expect(result).toBe(false);
    expect(renderError.mock.calls[0][0]).toContain('Failed to start new session:');
  });
});
