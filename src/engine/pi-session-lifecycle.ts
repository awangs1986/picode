import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface PiSessionIdentity {
  sessionId: string;
  sessionFile?: string;
}

type SeedableSessionManager = Pick<
  SessionManager,
  "getSessionFile" | "getSessionId" | "persistSessionSeed"
>;

export interface PiSessionCreateOptions {
  id?: string;
  parentSession?: string;
}

/**
 * Engine-owned Pi Session lifecycle module.
 *
 * It hides Pi's deferred first write: a returned identity is always backed by
 * a real JSONL that another process can reopen. Callers never write Pi JSONL.
 */
export class PiSessionLifecycle {
  constructor(private readonly sessionDir: string) {}

  static persistSeed(manager: SeedableSessionManager): string {
    const sessionFile = manager.persistSessionSeed();
    if (sessionFile === undefined) throw new Error("new session has no persistent file");
    return sessionFile;
  }

  identity(manager: Pick<SessionManager, "getSessionFile" | "getSessionId">): PiSessionIdentity {
    const sessionFile = manager.getSessionFile();
    return {
      sessionId: manager.getSessionId(),
      ...(sessionFile === undefined ? {} : { sessionFile }),
    };
  }

  persistSeed(manager: SeedableSessionManager): string {
    return PiSessionLifecycle.persistSeed(manager);
  }

  createSeeded(
    cwd: string,
    seed?: (manager: SessionManager) => void,
    options: PiSessionCreateOptions = {},
  ): PiSessionIdentity {
    mkdirSync(this.sessionDir, { recursive: true });
    const manager = SessionManager.create(cwd, this.sessionDir, options);
    seed?.(manager);
    this.persistSeed(manager);
    return this.identity(manager);
  }

  async resolve(value: string): Promise<PiSessionIdentity> {
    const direct = isAbsolute(value) ? value : resolve(value);
    if (existsSync(direct)) return this.identity(SessionManager.open(direct, this.sessionDir));
    const matches = (await SessionManager.listAll(this.sessionDir))
      .filter((session) => session.id === value || session.id.startsWith(value));
    if (matches.length !== 1) {
      throw new Error(matches.length === 0 ? `session not found: ${value}` : `session id is ambiguous: ${value}`);
    }
    const match = matches[0];
    if (match === undefined) throw new Error(`session not found: ${value}`);
    return { sessionId: match.id, sessionFile: match.path };
  }

  async open(value: string): Promise<SessionManager> {
    const identity = await this.resolve(value);
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${value}`);
    return SessionManager.open(identity.sessionFile, this.sessionDir);
  }
}
