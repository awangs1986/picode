import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";

function displayName(level: ModelThinkingLevel): string {
  return level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1);
}

export function registerThinkingCommand(pi: ExtensionAPI): void {
  pi.registerCommand("thinking", {
    description: "Select a thinking level supported by the current model",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.model === undefined) {
        ctx.ui.notify("Select a model before changing thinking level.", "warning");
        return;
      }

      const current = pi.getThinkingLevel();
      const levels = getSupportedThinkingLevels(ctx.model);
      const options = levels.map((level) =>
        `${displayName(level)}${level === current ? " (current)" : ""}`,
      );
      const selected = await ctx.ui.select(
        `Thinking level · ${ctx.model.provider}/${ctx.model.id}`,
        options,
      );
      if (selected === undefined) return;

      const selectedIndex = options.indexOf(selected);
      const level = levels[selectedIndex];
      if (level === undefined) return;

      // Pi's runtime supports "off" (and returns it from
      // getSupportedThinkingLevels), while ExtensionAPI's current declaration
      // still narrows setThinkingLevel to the non-off ThinkingLevel union.
      pi.setThinkingLevel(level as ThinkingLevel);
      ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
    },
  });
}
