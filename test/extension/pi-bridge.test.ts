import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../../src/extension/index.ts";
import {
  buildFreshReviewTask,
  candidateSnapshot,
  registerPicodeBridge,
} from "../../src/extension/pi-bridge.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

describe("fresh TDD review scope", () => {
  it("keeps the reviewer on the candidate and out of Picode runtime history", () => {
    const task = buildFreshReviewTask("node-counter");
    expect(task).toContain("git diff");
    expect(task).toContain(".picode-state");
    expect(task).toContain("structured {passed, blockers}");
  });
});

function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const tools = new Map<string, ToolDefinition>();
  const providers = new Map<string, unknown>();
  const appended: Array<[string, unknown]> = [];
  const sentMessages: string[] = [];
  let activeTools = ["read", "bash", "edit", "write"];
  const api = {
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) { activeTools = [...names]; },
    getAllTools: () => [...tools.values()].map((tool) => ({ ...tool, sourceInfo: { source: "extension" } })),
    registerProvider(name: string, config: unknown) { providers.set(name, config); },
    appendEntry(type: string, data: unknown) { appended.push([type, data]); },
    sendUserMessage(message: string) { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  return { api, handlers, commands, tools, providers, appended, sentMessages, activeTools: () => [...activeTools] };
}

function fakeContext(confirm: boolean, cwd = "C:/repo"): ExtensionContext {
  return {
    cwd,
    ui: { confirm: vi.fn(async () => confirm) },
    sessionManager: { getBranch: () => [], getSessionId: () => "session-1" },
  } as unknown as ExtensionContext;
}

describe("Pi 0.84 Bridge feasibility seam", () => {
  it("keeps Simple close to Pi and exposes todo plus search primitives in Standard", async () => {
    await withTempPicodeDir(async () => {
      const simplePi = fakePi();
      registerPicodeBridge(simplePi.api, createRuntime());
      await simplePi.handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        fakeContext(true),
      );
      expect(simplePi.activeTools()).not.toContain("todo_write");
      expect(simplePi.activeTools()).not.toContain("harness_result");
      expect(simplePi.activeTools()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));

      const standardPi = fakePi();
      registerPicodeBridge(standardPi.api, createRuntime());
      const standardCtx = {
        ...fakeContext(true),
        sessionManager: {
          getSessionId: () => "standard-tools",
          getBranch: () => [{ type: "custom", customType: "picode.harness-tier", data: { tier: "standard" } }],
        },
      } as ExtensionContext;
      await standardPi.handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        standardCtx,
      );
      expect(standardPi.activeTools()).toEqual(expect.arrayContaining(["todo_write", "grep", "find", "ls"]));
      expect(standardPi.activeTools()).not.toContain("harness_result");
    });
  });

  it("binds dirty candidate snapshots to file content, not only porcelain names", async () => {
    const makePi = (diff: string) => ({
      exec: vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
        if (args[0] === "status") return { code: 0, stdout: " M src/runtime.ts\n", stderr: "" };
        if (args[0] === "diff") return { code: 0, stdout: diff, stderr: "" };
        if (args[0] === "ls-files") return { code: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected git args ${args.join(" ")}`);
      }),
    }) as unknown as ExtensionAPI;

    const first = await candidateSnapshot(makePi("-old\n+first"), "C:/repo");
    const second = await candidateSnapshot(makePi("-old\n+second"), "C:/repo");

    expect(first.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contentDigest).not.toBe(second.contentDigest);
  });

  it("persists a session harness switch and reloads the extension suite", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    registerPicodeBridge(pi.api, runtime);
    const reload = vi.fn(async () => {});
    const notify = vi.fn();
    const ctx = { reload, ui: { notify } } as unknown as ExtensionContext;

    await pi.commands.get("harness")?.handler("standard", ctx);

    expect(runtime.harness.current()).toBe("standard");
    expect(pi.appended).toContainEqual(["picode.harness-tier", { tier: "standard" }]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("restores and changes the session permission tier through /permissions", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    const permissionReady = vi.fn(async () => {});
    registerPicodeBridge(pi.api, runtime, { onPermissionTierReady: permissionReady });
    const notify = vi.fn();
    const ctx = { ...fakeContext(true), ui: { notify } } as unknown as ExtensionContext;

    await pi.commands.get("permissions")?.handler("full", ctx);

    expect(runtime.guard.permissionTier()).toBe("full");
    expect(pi.appended).toContainEqual(["picode.permission-tier", { tier: "full" }]);
    expect(permissionReady).toHaveBeenCalledWith("full", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("full"), "warning");
  });

  it("restores the permission tier from the Pi session branch", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    registerPicodeBridge(pi.api, runtime);
    const ctx = {
      ...fakeContext(true),
      sessionManager: {
        getSessionId: () => "permission-session",
        getBranch: () => [{
          type: "custom",
          customType: "picode.permission-tier",
          data: { tier: "full" },
        }],
      },
    } as unknown as ExtensionContext;

    await pi.handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" } as never,
      ctx,
    );

    expect(runtime.guard.permissionTier()).toBe("full");
  });

  it("does not ask permission for a conservatively recognized read-only shell inspection", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    registerPicodeBridge(pi.api, runtime);
    const select = vi.fn(async () => "Deny");
    const result = await pi.handlers.get("tool_call")?.({
      type: "tool_call",
      toolCallId: "read-only-shell",
      toolName: "bash",
      input: { command: "Get-ChildItem ./src | Select-Object Name | Format-Table -AutoSize" },
    } as never, {
      ...fakeContext(true),
      ui: { select },
    } as unknown as ExtensionContext);

    expect(result).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps shell execution that is not proven read-only behind approval", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    registerPicodeBridge(pi.api, runtime);
    const select = vi.fn(async () => "Deny");
    const result = await pi.handlers.get("tool_call")?.({
      type: "tool_call",
      toolCallId: "unknown-shell",
      toolName: "bash",
      input: { command: "npm test" },
    } as never, {
      ...fakeContext(true),
      ui: { select },
    } as unknown as ExtensionContext);

    expect(result).toEqual({ block: true, reason: "user declined" });
    expect(select).toHaveBeenCalledOnce();
  });

  it("keeps /plan as a mattpocock compatibility entry without auto-installing", async () => {
    await withTempPicodeDir(async (dir) => {
      const pi = fakePi();
      registerPicodeBridge(pi.api, createRuntime());
      const skills = join(dir, ".agents", "skills", "setup-matt-pocock-skills");
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(skills, "SKILL.md"), "# Setup Matt Pocock's Skills\n", "utf8");
      const readyNotify = vi.fn();
      await pi.commands.get("plan")?.handler("ship feature", {
        ...fakeContext(true, dir),
        ui: { notify: readyNotify },
      } as unknown as ExtensionContext);
      expect(readyNotify).not.toHaveBeenCalled();
      expect(pi.sentMessages.at(-1)).toContain("grill-with-docs");
    });
  });

  it("exposes Account Vault operations through the Pi /accounts command", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const notify = vi.fn();
      await pi.commands.get("accounts")?.handler("list", { ui: { notify } } as unknown as ExtensionContext);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("no accounts"), "info");
    });
  });

  it("opens the account import Web Wizard and keeps a copyable URL fallback", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    registerPicodeBridge(pi.api, runtime, {
      startAccountImport: async () => ({
        url: new URL("http://127.0.0.1:1234/token/"),
        browserOpened: false,
      }),
    });
    const notify = vi.fn();
    await pi.commands.get("accounts")?.handler("import", { ui: { notify } } as unknown as ExtensionContext);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("http://127.0.0.1:1234/token/"),
      "warning",
    );
  });

  it("creates a sealed Capsule and starts a fresh Pi session through /slice", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const startCtx = {
        cwd: "C:/repo",
        sessionManager: {
          getSessionId: () => "session-original",
          getBranch: () => [],
        },
        ui: { setStatus: vi.fn() },
      } as unknown as ExtensionContext;
      await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, startCtx);

      const persistedEntries: Array<[string, unknown]> = [];
      const messages: unknown[] = [];
      const newSession = vi.fn(async (options: {
        setup?: (manager: { appendCustomEntry(type: string, data: unknown): string }) => Promise<void>;
        withSession?: (ctx: {
          sendMessage(message: unknown): Promise<void>;
          ui: { notify(): void };
          sessionManager: { getSessionId(): string };
          cwd: string;
        }) => Promise<void>;
      }) => {
        await options.setup?.({
          appendCustomEntry(type, data) { persistedEntries.push([type, data]); return "entry-1"; },
        });
        await options.withSession?.({
          async sendMessage(message) { messages.push(message); },
          ui: { notify: vi.fn() },
          sessionManager: { getSessionId: () => "session-slice" },
          cwd: "C:/repo",
        });
        return { cancelled: false };
      });
      const commandCtx = {
        ...startCtx,
        newSession,
        ui: { notify: vi.fn() },
      } as unknown as ExtensionContext;

      await pi.commands.get("slice")?.handler("Implement the next acceptance slice", commandCtx);

      expect(newSession).toHaveBeenCalledOnce();
      expect(persistedEntries).toContainEqual([
        "picode.task-binding",
        expect.objectContaining({ taskId: expect.any(String), taskRevision: 1 }),
      ]);
      expect(persistedEntries).toContainEqual([
        "picode.task-capsule",
        expect.objectContaining({ capsuleId: expect.any(String), status: "sealed" }),
      ]);
      expect(messages).toContainEqual(expect.objectContaining({
        customType: "picode.task-capsule",
        content: expect.stringContaining("Implement the next acceptance slice"),
      }));
    });
  });

  it("routes /accounts login through the pinned Pi provider auth flow", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const notify = vi.fn();
      const provider = {
        id: "openai-codex",
        name: "OpenAI Codex",
        auth: {
          oauth: {
            login: async () => ({
              type: "oauth",
              access: "access",
              refresh: "refresh",
              expires: Date.now() + 60_000,
            }),
          },
        },
      };
      const ctx = {
        ui: { notify, input: vi.fn(), select: vi.fn() },
        modelRegistry: { getProvider: (id: string) => id === provider.id ? provider : undefined },
      } as unknown as ExtensionContext;

      await pi.commands.get("accounts")?.handler("login openai-codex", ctx);

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("stored account"), "info");
      const listed = runtime.accounts.list();
      expect(listed.ok && listed.value[0]?.provider).toBe("openai-codex");
    });
  });

  it("applies /accounts use to the live Pi provider before reporting success", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      const imported = await runtime.accounts.importCredentials({
        provider: "openai",
        label: "Proxy",
        credentials: { accessToken: "cpa_secret", baseUrl: "https://proxy.example/v1" },
        defaultModel: "gpt-5.6-terra",
      });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      registerPicodeBridge(pi.api, runtime);
      const notify = vi.fn();
      const ctx = {
        ui: { notify },
        modelRegistry: { getProvider: (id: string) => id === "openai" ? {} : undefined },
      } as unknown as ExtensionContext;

      await pi.commands.get("accounts")?.handler(`use ${imported.value.id}`, ctx);

      expect(pi.providers.get("openai")).toMatchObject({
        apiKey: "cpa_secret",
        baseUrl: "https://proxy.example/v1",
      });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("active account"), "info");
    });
  });

  it("refreshes the active OAuth account before a turn reaches the provider", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      const imported = await runtime.accounts.importCredentials({
        provider: "openai-codex",
        label: "Codex",
        credentials: { accessToken: "expired", refreshToken: "refresh", expiresAt: 1 },
      });
      if (!imported.ok) return;
      await runtime.accounts.setActive(imported.value.id);
      const refresh = vi.fn(async () => ({
        type: "oauth" as const,
        access: "fresh",
        refresh: "rotated",
        expires: Date.now() + 3_600_000,
      }));
      const provider = {
        id: "openai-codex",
        name: "OpenAI Codex",
        auth: { oauth: { refresh } },
      };
      registerPicodeBridge(pi.api, runtime);
      const ctx = {
        model: { provider: "openai-codex" },
        modelRegistry: { getProvider: (id: string) => id === provider.id ? provider : undefined },
        signal: new AbortController().signal,
        ui: { notify: vi.fn() },
        abort: vi.fn(),
      } as unknown as ExtensionContext;

      await pi.handlers.get("turn_start")?.({ type: "turn_start" } as never, ctx);

      expect(refresh).toHaveBeenCalledOnce();
      expect(pi.providers.get("openai-codex")).toMatchObject({ apiKey: "fresh" });
      expect(ctx.abort).not.toHaveBeenCalled();
    });
  });

  it("lets the user choose the pi-subagents model from Pi's available model list", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const reload = vi.fn(async () => {});
      const notify = vi.fn();
      const ctx = {
        ui: { notify, select: vi.fn(async () => "openai/gpt-5-mini") },
        modelRegistry: {
          getAvailable: () => [
            { provider: "openai", id: "gpt-5-mini" },
            { provider: "anthropic", id: "claude-sonnet" },
          ],
        },
        reload,
      } as unknown as ExtensionContext;

      await pi.commands.get("subagent-model")?.handler("", ctx);

      expect(runtime.config.subagentModel).toBe("openai/gpt-5-mini");
      expect(reload).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("openai/gpt-5-mini"), "info");
    });
  });

  it("routes native tool intent through Guard and can block before execution", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    registerPicodeBridge(pi.api, runtime);
    const result = await pi.handlers.get("tool_call")?.(
      { type: "tool_call", toolCallId: "tc-1", toolName: "bash", input: { command: "npm test" } } as never,
      fakeContext(false),
    );
    expect(result).toEqual({ block: true, reason: "user declined" });
  });

  it("allows only one harness task to hold the writer lease for a workspace", async () => {
    await withTempPicodeDir(async () => {
      const firstPi = fakePi();
      const secondPi = fakePi();
      const first = createRuntime();
      const second = createRuntime();
      first.harness.switchTo("standard");
      second.harness.switchTo("standard");
      registerPicodeBridge(firstPi.api, first);
      registerPicodeBridge(secondPi.api, second);
      const context = (id: string) => ({
        cwd: "C:/shared-repo",
        sessionManager: {
          getSessionId: () => id,
          getBranch: () => [{
            type: "custom",
            customType: "picode.harness-tier",
            data: { tier: "standard" },
          }],
        },
        ui: { confirm: vi.fn(async () => true), select: vi.fn() },
      }) as unknown as ExtensionContext;
      const firstCtx = context("session-a");
      const secondCtx = context("session-b");
      await firstPi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, firstCtx);
      await secondPi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, secondCtx);
      const write = {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/main.ts", content: "x" },
      } as never;

      const firstResult = await firstPi.handlers.get("tool_call")?.(write, firstCtx);
      const secondResult = await secondPi.handlers.get("tool_call")?.(write, secondCtx);

      expect(firstResult).toBeUndefined();
      expect(secondResult).toEqual({
        block: true,
        reason: expect.stringContaining("managed worktree"),
      });
    });
  });

  it("admits tool results through the shared runtime envelope before observers", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    const observed: string[] = [];
    runtime.bus.subscribe((event) => { observed.push(event.kind); });
    registerPicodeBridge(pi.api, runtime);
    const event = {
      type: "tool_result",
      toolCallId: "tool-1",
      toolName: "mcp",
      input: {},
      content: [{ type: "text", text: "done" }],
      isError: false,
    };
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
    } as unknown as ExtensionContext;

    await pi.handlers.get("tool_result")?.(event as never, ctx);
    await pi.handlers.get("tool_result")?.(event as never, ctx);

    expect(observed.filter((kind) => kind === "tool.result")).toHaveLength(1);
  });

  it("turns a directory read failure into deterministic Pi-native ls guidance", async () => {
    const pi = fakePi();
    registerPicodeBridge(pi.api, createRuntime());
    const result = await pi.handlers.get("tool_result")?.({
      type: "tool_result",
      toolCallId: "read-directory",
      toolName: "read",
      input: { path: "D:/repo/src" },
      content: [{ type: "text", text: "EISDIR: illegal operation on a directory, read" }],
      isError: true,
    } as never, fakeContext(true));

    expect(result).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: expect.stringContaining("Use the Pi-native ls tool") },
      ],
    });
  });

  it("observes compact and session-history lifecycle through public Pi events", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    const probe = registerPicodeBridge(pi.api, runtime);
    const before = runtime.cacheMeter.snapshot().cacheEpoch;
    await pi.handlers.get("session_compact")?.(
      { type: "session_compact", reason: "threshold", fromExtension: false } as never,
      fakeContext(true),
    );
    await pi.handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" } as never,
      fakeContext(true),
    );
    await pi.handlers.get("session_tree")?.(
      { type: "session_tree", oldLeafId: "a", newLeafId: "b" } as never,
      fakeContext(true),
    );
    expect(runtime.cacheMeter.snapshot().cacheEpoch).toBe(before + 1);
    expect(probe.snapshot()).toMatchObject({ compactionsObserved: 1, historyTransitionsObserved: 2 });
  });

  it("restores the session tier before asking the composition root to load vendors", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    const loaded: string[] = [];
    registerPicodeBridge(pi.api, runtime, { onTierReady: async (tier) => { loaded.push(tier); } });
    const ctx = {
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "picode.harness-tier", data: { tier: "tdd" } },
        ],
      },
    } as unknown as ExtensionContext;
    await pi.handlers.get("session_start")?.(
      { type: "session_start", reason: "reload" } as never,
      ctx,
    );
    expect(runtime.harness.current()).toBe("tdd");
    expect(loaded).toEqual(["tdd"]);
  });

  it("hands session startup to the first-run adapter after the tier is ready", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    const order: string[] = [];
    registerPicodeBridge(pi.api, runtime, {
      onTierReady: async () => { order.push("tier"); },
      onSessionReady: async () => { order.push("onboarding"); },
    });

    await pi.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" } as never,
      fakeContext(true),
    );

    expect(order).toEqual(["tier", "onboarding"]);
  });

  it("records in-process tool-intent latency without IPC", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    runtime.guard.setTier("full");
    let now = 10;
    const probe = registerPicodeBridge(pi.api, runtime, { now: () => ++now });
    await pi.handlers.get("tool_call")?.(
      { type: "tool_call", toolCallId: "tc-2", toolName: "read", input: { path: "README.md" } } as never,
      fakeContext(true),
    );
    expect(probe.snapshot().toolIntentLatencyMs).toEqual([1]);
  });

  it("projects real Pi usage into the cache status widget", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    registerPicodeBridge(pi.api, runtime);
    const setStatus = vi.fn();
    await pi.handlers.get("turn_end")?.(
      {
        type: "turn_end",
        turnIndex: 0,
        message: { role: "assistant", usage: { input: 100, cacheRead: 900, cacheWrite: 0 } },
        toolResults: [],
      } as never,
      { ui: { setStatus } } as unknown as ExtensionContext,
    );
    expect(setStatus).toHaveBeenCalledWith("picode-cache", expect.stringContaining("90%"));
  });

  it("records real prefix signals and cache usage without exposing prompt material", async () => {
    await withTempPicodeDir(async (dir) => {
      const pi = fakePi();
      Object.assign(pi.api, {
        getActiveTools: () => ["read"],
        getAllTools: () => [{
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          sourceInfo: { source: "core" },
        }],
      });
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const ctx = {
        model: {
          provider: "openai",
          id: "gpt-test",
          baseUrl: "https://example.invalid/v1",
        },
        sessionManager: {
          getSessionId: () => "cache-session",
          getBranch: () => [{ id: "first-entry", type: "message" }],
        },
        ui: { setStatus: vi.fn() },
      } as unknown as ExtensionContext;

      await pi.handlers.get("before_agent_start")?.({
        type: "before_agent_start",
        prompt: "secret user prompt",
        systemPrompt: "secret system prompt",
        systemPromptOptions: { cwd: dir },
      } as never, ctx);
      await pi.handlers.get("turn_end")?.({
        type: "turn_end",
        turnIndex: 0,
        message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 900 } },
        toolResults: [],
      } as never, ctx);

      const file = join(dir, "metrics", `cache-${new Date().toISOString().slice(0, 7).replace("-", "")}.jsonl`);
      const line = readFileSync(file, "utf8").trim();
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record).toMatchObject({
        sessionId: "cache-session",
        signals: {
          provider: "openai",
          model: "gpt-test",
          baseUrl: "https://example.invalid/v1",
          systemDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          toolSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          retainedHistoryAnchorDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(line).not.toContain("secret system prompt");
      expect(line).not.toContain("secret user prompt");
    });
  });

  it("recommends a Slice once when a standard session crosses the context threshold", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    runtime.harness.switchTo("standard");
    registerPicodeBridge(pi.api, runtime);
    const notify = vi.fn();
    const ctx = {
      getContextUsage: () => ({ tokens: 61_000, contextWindow: 100_000, percent: 61 }),
      ui: { notify, setStatus: vi.fn() },
    } as unknown as ExtensionContext;
    const event = {
      message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } },
    } as never;

    await pi.handlers.get("turn_end")?.(event, ctx);
    await pi.handlers.get("turn_end")?.(event, ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/slice"), "warning");
  });

  it("registers the existing search_tools domain handler as a real Pi tool", async () => {
    const pi = fakePi();
    const runtime = createRuntime();
    registerPicodeBridge(pi.api, runtime);

    const tool = pi.tools.get("search_tools");
    expect(tool).toBeDefined();
    const result = await tool?.execute(
      "search-1",
      { action: "search", query: "web" },
      undefined,
      undefined,
      fakeContext(true),
    );

    expect(result?.content).toEqual([
      { type: "text", text: expect.stringContaining("pi-web-access") },
    ]);
  });

  it("injects the stable TDD core prompt and blocks production writes before recorded RED", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const ctx = {
        cwd: "C:/repo",
        sessionManager: {
          getSessionId: () => "tdd-session",
          getBranch: () => [{
            type: "custom",
            customType: "picode.harness-tier",
            data: { tier: "tdd" },
          }],
        },
        ui: { confirm: vi.fn(async () => true), select: vi.fn() },
      } as unknown as ExtensionContext;
      await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, ctx);

      const prompt = await pi.handlers.get("before_agent_start")?.({
        type: "before_agent_start",
        prompt: "build",
        systemPrompt: "PI BASE",
        systemPromptOptions: {},
      } as never, ctx) as { systemPrompt?: string } | undefined;
      const blocked = await pi.handlers.get("tool_call")?.({
        type: "tool_call",
        toolCallId: "write-prod",
        toolName: "write",
        input: { path: "src/runtime.ts", content: "x" },
      } as never, ctx);

      expect(prompt?.systemPrompt).toContain("PI BASE");
      expect(prompt?.systemPrompt).toContain("Picode TDD Harness");
      expect(blocked).toEqual({ block: true, reason: expect.stringContaining("recorded RED") });
      expect(pi.tools.has("harness_result")).toBe(true);
    });
  });

  it("appends the lean standard prompt to Pi Base through before_agent_start", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const ctx = {
        cwd: "C:/repo",
        sessionManager: {
          getSessionId: () => "standard-prompt-session",
          getBranch: () => [{
            type: "custom",
            customType: "picode.harness-tier",
            data: { tier: "standard" },
          }],
        },
        ui: { confirm: vi.fn(async () => true), select: vi.fn() },
      } as unknown as ExtensionContext;
      await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, ctx);

      const prompt = await pi.handlers.get("before_agent_start")?.({
        type: "before_agent_start",
        prompt: "build",
        systemPrompt: "PI BASE",
        systemPromptOptions: {},
      } as never, ctx) as { systemPrompt?: string } | undefined;

      expect(prompt?.systemPrompt).toContain("PI BASE");
      expect(prompt?.systemPrompt).toContain("Picode Harness Core (Lean)");
      expect(prompt?.systemPrompt).not.toContain("recorded RED");
    });
  });

  it("blocks an obvious shell write before TDD has recorded RED", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const ctx = {
        cwd: "C:/repo",
        sessionManager: {
          getSessionId: () => "tdd-shell-session",
          getBranch: () => [{ type: "custom", customType: "picode.harness-tier", data: { tier: "tdd" } }],
        },
        ui: { confirm: vi.fn(async () => true), select: vi.fn(), notify: vi.fn() },
      } as unknown as ExtensionContext;
      await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, ctx);

      const blocked = await pi.handlers.get("tool_call")?.({
        type: "tool_call",
        toolCallId: "bash-write-prod",
        toolName: "bash",
        input: { command: "Set-Content src/runtime.ts broken" },
      } as never, ctx);

      expect(blocked).toEqual({ block: true, reason: expect.stringContaining("recorded RED") });
    });
  });

  it("discovers TOOLS.md per harness task and injects only its compact summary", async () => {
    await withTempPicodeDir(async (dir) => {
      writeFileSync(join(dir, "TOOLS.md"), "## asset-check\nValidate game assets.\nkeywords: assets\n", "utf8");
      const pi = fakePi();
      const runtime = createRuntime();
      registerPicodeBridge(pi.api, runtime);
      const ctx = {
        cwd: dir,
        isProjectTrusted: () => true,
        sessionManager: {
          getSessionId: () => "tools-session",
          getBranch: () => [{ type: "custom", customType: "picode.harness-tier", data: { tier: "standard" } }],
        },
        ui: { notify: vi.fn() },
      } as unknown as ExtensionContext;
      await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, ctx);

      const result = await pi.handlers.get("before_agent_start")?.({
        type: "before_agent_start",
        prompt: "go",
        systemPrompt: "PI BASE",
        systemPromptOptions: {},
      } as never, ctx) as { message?: { content?: string } } | undefined;

      expect(runtime.guard.catalog.search("asset").map((item) => item.id)).toContain("task:asset-check");
      expect(result?.message?.content).toContain("task:asset-check");
      expect(result?.message?.content).not.toContain("keywords:");
    });
  });
});
