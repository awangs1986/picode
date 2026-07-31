function detectPlatform(navigatorLike = globalThis.navigator) {
  const platform = navigatorLike?.platform || navigatorLike?.userAgent || "unknown";
  if (/win/i.test(platform)) return "windows";
  if (/mac/i.test(platform)) return "macos";
  if (/linux/i.test(platform)) return "linux";
  return "unknown";
}

export class TaskExperience {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.platform = options.platform || detectPlatform(options.navigatorLike);
  }

  async createTask({ chatId, goal = "", mode = "conversation" }) {
    if (!this.transport) throw new Error("Task Control is not connected.");
    const normalizedGoal = String(goal || "").trim();

    if (mode === "conversation") {
      return this.transport.createSimpleTask(chatId, normalizedGoal);
    }
    if (mode !== "project") throw new Error(`Unknown task mode: ${mode}`);

    const localPath = await this.transport.pickFolder();
    if (!localPath) return null;
    const workspace = await this.transport.registerWorkspace(this.platform, localPath, localPath);
    return this.transport.createHarnessTask(chatId, normalizedGoal, workspace.id);
  }
}
