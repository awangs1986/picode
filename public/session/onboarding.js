import { t } from "../i18n/index.js";

export function getOnboardingState({ hasSessions, workspacePath, availableModels }) {
  const hasWorkspace = typeof workspacePath === "string" && workspacePath.trim().length > 0;
  const hasModel = Array.isArray(availableModels) && availableModels.length > 0;

  if (!hasWorkspace && !hasSessions) {
    return {
      canQuery: false,
      canType: false,
      needsProject: true,
      needsModel: false,
      message: t("onboarding.openProject", {}, "Open a project to start chatting."),
    };
  }

  if (!hasModel) {
    return {
      canQuery: false,
      canType: true,
      needsProject: false,
      needsModel: true,
      message: t(
        "onboarding.configureProvider",
        {},
        "Configure an API key or provider to start chatting.",
      ),
    };
  }

  return {
    canQuery: true,
    canType: true,
    needsProject: false,
    needsModel: false,
    message: "",
  };
}
