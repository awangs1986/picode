import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import open from "open";
import { bootRuntime } from "./index.ts";
import { registerPicodeBridge } from "./pi-bridge.ts";
import { loadSuiteForTier, suiteForTier } from "./suite.ts";
import { startAccountImportWizard } from "./account-import-wizard.ts";
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

/** Real Pi extension entry. Keep this file as a thin composition adapter. */
export default function picodeExtension(pi: ExtensionAPI): void {
  registerInputCursorBlink(pi);
  registerSubagentControlCommand(pi);
  const disposeWindowsShellProvider = registerWindowsPowerShellProvider(pi);
  pi.on("session_shutdown", () => { disposeWindowsShellProvider(); });
  const toolAdapter = new PiActiveToolAdapter(pi);
  const loadedSuitePackages = new Set<string>();
  const runtime = bootRuntime({ toolAdapter });
  // HTTP/SSE is an internal diagnostic transport, not the public control plane.
  // Normal TUI/CLI startup therefore opens no debug port.
  if (process.env["PICODE_DEBUG_API"] === "1") {
    void startDebugApi(runtime).catch((cause: unknown) => {
      console.error("[picode] debug API failed to start", cause);
    });
  }
  let activeContext: ExtensionContext | undefined;
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
        (entry, toolNames) => { toolAdapter.bind(entry.manifest.id, toolNames); },
        loadedSuitePackages,
      );
      registerWindowsPowerShellTool(pi, ctx.cwd);
      toolAdapter.reconcile(suiteForTier(tier).map((entry) => entry.manifest.id));
      const readiness = await CapabilityReadinessRegistry.defaults().inspectAll({ cwd: ctx.cwd, harnessTier: tier });
      pi.setActiveTools(filterToolNamesForReadiness(pi.getActiveTools(), readiness));
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
