import type { CapabilityCatalog } from "../guard/catalog.ts";
import type {
  CapabilityManifest,
  PersistedCapabilitySettings,
  Result,
} from "../shared/types.ts";
import type { PicodeConfig } from "../store/config.ts";
import { applyOnboarding, onboardingQuestions } from "./onboarding.ts";

export const ONBOARDING_MANIFESTS: readonly CapabilityManifest[] = [
  {
    id: "mattpocock-skills",
    kind: "skill",
    title: "mattpocock/skills",
    summary: "Curated software-development skills loaded on demand",
    keywords: ["skills", "typescript", "development"],
    supportsProxyCall: true,
    origin: "suite",
  },
  {
    id: "herdr",
    kind: "pi-extension",
    title: "Herdr",
    summary: "Optional multi-task and multi-agent orchestration host",
    keywords: ["multi-agent", "orchestration", "tasks"],
    supportsProxyCall: false,
    origin: "suite",
  },
  {
    id: "codebase-memory-provider",
    kind: "mcp-server",
    title: "CodebaseMemoryProvider",
    summary: "Repository memory, structural indexing, and cross-session retrieval",
    keywords: ["memory", "codebase", "index", "retrieval"],
    supportsProxyCall: true,
    origin: "suite",
  },
];

export interface OnboardingFlowDeps {
  config: PicodeConfig;
  catalog: CapabilityCatalog;
  confirm(title: string, message: string): Promise<boolean>;
  persistConfig(config: PicodeConfig): Promise<Result<void>>;
  persistCapabilities(settings: PersistedCapabilitySettings[]): Promise<Result<void>>;
}

export async function runOnboardingFlow(
  deps: OnboardingFlowDeps,
): Promise<Result<PicodeConfig>> {
  const answers: Record<string, boolean> = {};
  for (const question of onboardingQuestions(deps.config.locale)) {
    answers[question.capabilityId] = await deps.confirm("Picode setup", question.text);
  }
  const next = applyOnboarding(answers, deps.catalog, deps.config);
  const capabilities = await deps.persistCapabilities(deps.catalog.toJSON());
  if (!capabilities.ok) return capabilities;
  const config = await deps.persistConfig(next);
  if (!config.ok) return config;
  return { ok: true, value: next };
}
