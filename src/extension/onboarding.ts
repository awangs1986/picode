import type { CapabilityCatalog } from "../guard/index.ts";
import type { PicodeConfig } from "../store/config.ts";

/**
 * 首次启动引导（PICODE-V3-DESIGN.md §3.7，R3 回归）：
 * 两项外部运行时推荐分别独立询问 Y/N，不提供"一键全部启用"；
 * 介绍文字跟随界面语言；跳过后不重复打扰，可在设置重开；
 * 启用 ≠ 常驻运行——只进二级驻留（Enabled + Trusted 的可发现 manifest）。
 */

export interface OnboardingItem {
  capabilityId: string;
  intro: { zh: string; en: string };
  defaultAnswer: boolean;
}

export const ONBOARDING_ITEMS: readonly OnboardingItem[] = [
  {
    capabilityId: "herdr",
    intro: {
      zh: "Herdr：多任务与多 Agent 编排；只有实际使用时才启动。（不替代内置的 pi-subagents 委派底座）",
      en: "Herdr: multi-task and multi-agent orchestration; starts only when actually used. (Does not replace the built-in pi-subagents delegation layer.)",
    },
    defaultAnswer: true,
  },
  {
    capabilityId: "codebase-memory-provider",
    intro: {
      zh: "CodebaseMemoryProvider：代码库级长期记忆、结构索引和跨会话检索。",
      en: "CodebaseMemoryProvider: repository-level long-term memory, structural indexing and cross-session retrieval.",
    },
    defaultAnswer: true,
  },
];

export function shouldRunOnboarding(config: PicodeConfig): boolean {
  return !config.onboarding.completed;
}

/** 逐项问题文本（两项分别介绍，不能合并成一个"全部启用"问题） */
export function onboardingQuestions(locale: "zh" | "en"): { capabilityId: string; text: string }[] {
  return ONBOARDING_ITEMS.map((item) => ({
    capabilityId: item.capabilityId,
    text: item.intro[locale],
  }));
}

/**
 * 应用用户逐项选择：Y = Enable + Trust（进二级驻留：可发现、未运行）。
 * 不选择不影响原版 pi 基础能力；未回答的项视为 N。
 * 返回更新后的 config（调用方负责 saveConfig）。
 */
export function applyOnboarding(
  answers: Record<string, boolean>,
  catalog: CapabilityCatalog,
  config: PicodeConfig,
): PicodeConfig {
  for (const item of ONBOARDING_ITEMS) {
    if (answers[item.capabilityId] === true) {
      catalog.userSetState(item.capabilityId, "trusted");
    }
  }
  return {
    ...config,
    onboarding: { completed: true, answeredAt: new Date().toISOString() },
  };
}

/** 跳过：completed=true 但不动目录（以后可在"专业扩展"或重开向导启用） */
export function skipOnboarding(config: PicodeConfig): PicodeConfig {
  return { ...config, onboarding: { completed: true, answeredAt: new Date().toISOString() } };
}

/** 设置里重新打开向导 */
export function reopenOnboarding(config: PicodeConfig): PicodeConfig {
  return { ...config, onboarding: { completed: false } };
}
