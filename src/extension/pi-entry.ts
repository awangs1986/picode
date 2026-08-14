import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import open from "open";
import { bootRuntime } from "./index.ts";
import { registerPicodeBridge } from "./pi-bridge.ts";
import {
  loadSuiteForTier,
  measureToolSchemaBudget,
  suiteForTier,
  withinSimpleToolBudget,
} from "./suite.ts";
import { startAccountImportWizard } from "./account-import-wizard.ts";
import { refreshCursorModelCatalog } from "./cursor-model-catalog.ts";
import { shouldRunOnboarding } from "./onboarding.ts";
import { runOnboardingFlow } from "./onboarding-runner.ts";
import {
  loadCapabilitySettings,
  saveCapabilitySettings,
} from "../store/capabilities.ts";
import { saveConfig } from "../store/config.ts";
import { PiActiveToolAdapter } from "./pi-tool-adapter.ts";
import { registerMcpApprovalBridge } from "./mcp-approval-bridge.ts";
import { configureLandstripForSession } from "./landstrip-config.ts";
import { piAgentDir, piSessionsDir } from "../shared/paths.ts";
import { configureSubagentsForSession } from "./subagent-config.ts";
import { registerSubagentEnvelopeBridge } from "./subagent-envelope-bridge.ts";
import { startDebugApi } from "../api/server.ts";
import { err, ok } from "../shared/types.ts";
import {
  registerWindowsPowerShellProvider,
  registerWindowsPowerShellTool,
} from "./windows-shell-provider.ts";
import { CapabilityReadinessRegistry, filterToolNamesForReadiness } from "../engine/readiness.ts";
import { ensureTunSsrfCompatibility } from "./web-ssrf-config.ts";
import { registerSubagentControlCommand } from "./subagent-control-command.ts";
import { WebChatImportCoordinator } from "./web-chat-import.ts";
import {
  formatRecommendedReinstallReport,
  runRecommendedReinstall,
} from "./reinstall-command.ts";
import { findMattPocockSkills } from "./plan-command.ts";
import {
  bundledSkillNames,
  materializeMattPocockSkills,
  mattPocockInstallRoot,
} from "./mattpocock-bundle.ts";
import { registerInputCursorBlink } from "./input-cursor-blink.ts";
import { registerModelContinuity } from "./model-continuity.ts";
import { registerInterjection } from "./interjection.ts";
import { registerThinkingCommand } from "./thinking-command.ts";
import { startRemoteServe, type RemoteServeHandle } from "../serve/server.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { advertisedIpv4 } from "../serve/network.ts";
import { TuiControlDriver } from "./tui-control-driver.ts";
import { WeixinController } from "./weixin-controller.ts";
import { compactWeixinReply } from "./weixin-reply-compactor.ts";
import { ChatWriterLeases } from "../guard/chat-writer-lease.ts";

/** Real Pi extension entry. Keep this file as a thin composition adapter. */
function remoteAdvertisedHost(): string {
  const configured = process.env["PICODE_SERVE_ADVERTISE"];
  return configured !== undefined && configured.trim() !== "" ? configured : (advertisedIpv4() ?? "127.0.0.1");
}

export default function picodeExtension(pi: ExtensionAPI): void {
  registerThinkingCommand(pi);
  registerInputCursorBlink(pi);
  registerInterjection(pi);
  registerSubagentControlCommand(pi);
  const disposeWindowsShellProvider = registerWindowsPowerShellProvider(pi);
  pi.on("session_shutdown", () => { disposeWindowsShellProvider(); });
  const toolAdapter = new PiActiveToolAdapter(pi);
  const loadedSuitePackages = new Set<string>();
  const simpleExtensionToolNames = new Set<string>();
  const runtime = bootRuntime({ toolAdapter });
  const writerLeases = new ChatWriterLeases();
  const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  // HTTP/SSE is an internal diagnostic transport, not the public control plane.
  // Normal TUI/CLI startup therefore opens no debug port.
  if (process.env["PICODE_DEBUG_API"] === "1") {
    void startDebugApi(runtime).catch((cause: unknown) => {
      console.error("[picode] debug API failed to start", cause);
    });
  }
  let activeContext: ExtensionContext | undefined;
  let weixinCommandContext: ExtensionCommandContext | undefined;
  let remoteCommandContext: ExtensionCommandContext | undefined;
  let remoteServe: RemoteServeHandle | undefined;
  const weixin = new WeixinController({
    runtime,
    persistCapabilities: saveCapabilitySettings,
    runTurn: async ({ sessionId, prompt }) => {
      const context = weixinCommandContext;
      if (context === undefined || context.sessionManager.getSessionId() !== sessionId) {
        throw new Error(`Chat ${sessionId} is no longer active in the Pi TUI`);
      }
      const driver = new TuiControlDriver({
        packageRoot,
        piEntry: join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
        cwd: context.cwd,
        env: { ...process.env },
      }, pi, context);
      for await (const event of driver.run({ prompt, session: sessionId, nonInteractive: true })) {
        if (event.kind === "run.completed") {
          const payload = event.payload as { text?: unknown };
          if (typeof payload.text !== "string" || payload.text.trim() === "") {
            throw new Error("Pi completed without a text reply");
          }
          return payload.text;
        }
        if (event.kind === "run.error" || event.kind === "run.timeout" || event.kind === "run.cancelled") {
          const payload = event.payload as { message?: unknown };
          throw new Error(typeof payload.message === "string" ? payload.message : `Pi turn ended as ${event.kind}`);
        }
      }
      throw new Error("Pi turn ended without a completion event");
    },
    compactReply: async ({ sessionId, text }) => {
      const context = weixinCommandContext;
      if (context === undefined || context.sessionManager.getSessionId() !== sessionId) {
        throw new Error(`Chat ${sessionId} is no longer active in the Pi TUI`);
      }
      const model = context.model;
      if (model === undefined) throw new Error("The active Pi TUI has no selected model for Weixin reply compaction");
      return compactWeixinReply(
        text,
        (compactContext) => context.modelRegistry.complete(model, compactContext),
      );
    },
  });
  pi.registerCommand("weixin", {
    description: "Connect the current Chat to a Weixin iLink Bot private conversation",
    handler: async (args, ctx) => {
      weixinCommandContext = ctx;
      const sessionFile = ctx.sessionManager.getSessionFile();
      await weixin.execute(args, {
        sessionId: ctx.sessionManager.getSessionId(),
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ui: ctx.ui,
      });
    },
  });
  registerMcpApprovalBridge(pi.events, runtime, () => activeContext);
  registerSubagentEnvelopeBridge(pi.events, runtime);
  let capabilitySettingsRestored = false;
  let webSsrfPrepared = false;
  registerPicodeBridge(pi, runtime, {
    onTierReady: async (tier, ctx) => {
      if (!webSsrfPrepared) {
        try {
          const compatibility = await ensureTunSsrfCompatibility();
          if (compatibility.changed) {
            ctx.ui.notify(
              `Detected TUN/fake-IP DNS; enabled pi-web-access SSRF compatibility for ${compatibility.range}`,
              "warning",
            );
          }
        } catch (cause) {
          ctx.ui.notify(
            `Could not reconcile pi-web-access network settings: ${cause instanceof Error ? cause.message : String(cause)}`,
            "warning",
          );
        }
        webSsrfPrepared = true;
      }
      const configured = await configureLandstripForSession({
        harnessTier: tier,
        permissionTier: runtime.guard.permissionTier(),
        cwd: ctx.cwd,
        agentDir: piAgentDir(),
        deniedWriteRoots: runtime.guard.forbiddenWriteRoots(),
      });
      if (!configured.ok) ctx.ui.notify(configured.error.message, "error");
      else if (process.platform === "win32" && tier !== "simple") {
        ctx.ui.notify(
          "Windows OS sandbox is deferred to P5; Guard permissions remain active and PowerShell runs with host access.",
          "warning",
        );
      }
      const subagentsConfigured = await configureSubagentsForSession({
        harnessTier: tier,
        agentDir: piAgentDir(),
        ...(runtime.config.subagentModel === undefined
          ? {}
          : { defaultModel: runtime.config.subagentModel }),
      });
      if (!subagentsConfigured.ok) ctx.ui.notify(subagentsConfigured.error.message, "error");
      await loadSuiteForTier(
        pi,
        tier,
        undefined,
        (entry, toolNames) => {
          toolAdapter.bind(entry.manifest.id, toolNames);
          if (entry.tiers.includes("simple")) {
            for (const name of toolNames) simpleExtensionToolNames.add(name);
          }
        },
        loadedSuitePackages,
      );
      registerWindowsPowerShellTool(pi, ctx.cwd);
      toolAdapter.reconcile(suiteForTier(tier).map((entry) => entry.manifest.id));
      const readiness = await CapabilityReadinessRegistry.defaults().inspectAll({ cwd: ctx.cwd, harnessTier: tier });
      pi.setActiveTools(filterToolNamesForReadiness(pi.getActiveTools(), readiness));
      if (tier === "simple") {
        const active = new Set(pi.getActiveTools());
        const report = measureToolSchemaBudget(pi.getAllTools().filter(
          (tool) => active.has(tool.name) && simpleExtensionToolNames.has(tool.name),
        ));
        ctx.ui.setStatus(
          "picode-simple-schema",
          `Simple extensions ${report.estimatedTokens} tokens / 4096`,
        );
        if (!withinSimpleToolBudget(report)) {
          pi.setActiveTools(pi.getActiveTools().filter((name) => !simpleExtensionToolNames.has(name)));
          ctx.ui.notify(
            "Simple extension tool schemas exceeded the 4096-token budget and were disabled for this session.",
            "error",
          );
        }
      }
    },
    onPermissionTierReady: async (permissionTier, ctx) => {
      const configured = await configureLandstripForSession({
        harnessTier: runtime.harness.current(),
        permissionTier,
        cwd: ctx.cwd,
        agentDir: piAgentDir(),
        deniedWriteRoots: runtime.guard.forbiddenWriteRoots(),
      });
      if (!configured.ok) ctx.ui.notify(configured.error.message, "error");
    },
    onSessionReady: async (ctx) => {
      activeContext = ctx;
      await weixin.onSessionChanged(ctx.sessionManager.getSessionId());
      runtime.bindRemoteMessageSender(async (sessionId, message) => {
        if (activeContext === undefined || activeContext.sessionManager.getSessionId() !== sessionId) {
          return err("api/session-not-active", `session ${sessionId} is not the active Pi session`);
        }
        pi.sendUserMessage(message, {
          ...(activeContext.isIdle() ? {} : { deliverAs: "steer" as const }),
        });
        return ok(undefined);
      });
      if (!capabilitySettingsRestored) {
        const saved = await loadCapabilitySettings();
        if (saved.ok) runtime.guard.catalog.restoreSettings(saved.value);
        else if (saved.error.code !== "store/state-missing") {
          ctx.ui.notify(saved.error.message, "warning");
        }
        capabilitySettingsRestored = true;
      }
      if (ctx.mode !== "tui" || !shouldRunOnboarding(runtime.config)) return;
      const completed = await runOnboardingFlow({
        config: runtime.config,
        catalog: runtime.guard.catalog,
        confirm: (title, message) => ctx.ui.confirm(title, message),
        persistConfig: saveConfig,
        persistCapabilities: saveCapabilitySettings,
      });
      if (!completed.ok) {
        ctx.ui.notify(`Picode setup was not saved: ${completed.error.message}`, "error");
        return;
      }
      runtime.config = completed.value;
      ctx.ui.notify("Picode setup saved. Optional capabilities remain stopped until used.", "info");
    },
    onServe: async (ctx) => {
      if (ctx.sessionManager.getSessionFile() === undefined) {
        throw new Error("current Chat is not persisted yet; send one message before /server");
      }
      if (remoteServe === undefined) {
        remoteCommandContext = ctx;
        const advertisedHost = remoteAdvertisedHost();
        const driver = new TuiControlDriver({
          packageRoot,
          piEntry: join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
          cwd: ctx.cwd,
          env: { ...process.env },
        }, pi, remoteCommandContext);
        remoteServe = await startRemoteServe({
          driver,
          bind: process.env["PICODE_SERVE_BIND"] ?? "0.0.0.0",
          advertisedHost,
          port: Number(process.env["PICODE_SERVE_PORT"] ?? "7878"),
          hostName: process.env["PICODE_SERVE_NAME"] ?? hostname(),
          newChatWorkspace: ctx.cwd,
          writerLeases,
        });
      } else {
        await remoteServe.rotatePairing();
      }
      const pairing = JSON.parse(remoteServe.pairingPayload) as { pairingCode: string; expiresAt: string };
      return { endpoint: remoteServe.endpoint, pairingCode: pairing.pairingCode, expiresAt: pairing.expiresAt };
    },
    onReinstall: async (ctx) => {
      const result = await runRecommendedReinstall({
        locale: runtime.config.locale,
        catalog: runtime.guard.catalog,
        confirm: (title, message) => ctx.ui.confirm(title, message),
        mattPocockInstalled: () => findMattPocockSkills(ctx.cwd).installed,
        installMattPocock: () => {
          const installed = materializeMattPocockSkills(bundledSkillNames(), mattPocockInstallRoot());
          return installed.ok ? ok(undefined) : installed;
        },
        persistCapabilities: saveCapabilitySettings,
      });
      if (!result.ok) {
        ctx.ui.notify(`Picode reinstall failed: ${result.error.message}`, "error");
        return;
      }
      ctx.ui.notify(formatRecommendedReinstallReport(result.value, runtime.config.locale), "info");
      if (result.value.installed.includes("mattpocock-skills")) await ctx.reload();
    },
    startAccountImport: (onImported) => {
      const chats = new WebChatImportCoordinator(runtime, piSessionsDir());
      return startAccountImportWizard({
        accounts: runtime.accounts,
        openBrowser: async (url) => { await open(url); },
        onImported,
        chatImport: {
          scan: async (input) => chats.scan(input),
          apply: async (input) => chats.apply(input),
        },
      });
    },
    refreshImportedProviderModels: async ({ provider, apiKey }) => {
      if (provider !== "cursor") {
        throw new Error(`automatic model refresh is not supported for ${provider}`);
      }
      const refreshed = await refreshCursorModelCatalog(apiKey);
      return {
        models: refreshed.models,
        ...(refreshed.fallbackIssue === undefined
          ? {}
          : { fallbackWarning: refreshed.fallbackIssue.message }),
      };
    },
  });
  pi.on("session_shutdown", () => {
    const handle = remoteServe;
    remoteServe = undefined;
    if (handle !== undefined) void handle.close();
    void weixin.shutdown();
  });
  registerModelContinuity(pi, {
    store: {
      current: () => runtime.config,
      persist: async (model) => {
        runtime.config = { ...runtime.config, lastConversationModel: model };
        return (await saveConfig(runtime.config)).ok;
      },
    },
  });
}
