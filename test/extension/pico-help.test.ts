import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildHelpCatalog,
  registerPicoHelpCommand,
  renderHelpDirectory,
} from "../../src/extension/pico-help.ts";

describe("Picode command directory", () => {
  it("groups Pi, Picode, and dynamically loaded extension commands without duplicates", () => {
    const catalog = buildHelpCatalog([
      { name: "harness", description: "Switch harness", source: "extension" },
      { name: "weixin", description: "Connect Weixin", source: "extension" },
      { name: "wayfinder", description: "Map a codebase", source: "skill" },
      { name: "model", description: "Override duplicate", source: "extension" },
    ], "zh");

    const commands = catalog.flatMap((category) => category.commands);
    expect(commands.filter((command) => command.name === "model")).toHaveLength(1);
    expect(commands.find((command) => command.name === "harness")).toMatchObject({
      category: "harness",
      usage: "/harness [simple|standard|tdd]",
    });
    expect(commands.find((command) => command.name === "weixin")?.category).toBe("remote");
    expect(commands.find((command) => command.name === "wayfinder")?.category).toBe("extensions");
    expect(commands.find((command) => command.name === "compact")?.owner).toBe("pi");
  });

  it("renders a searchable, categorized full directory", () => {
    const catalog = buildHelpCatalog([
      { name: "harness", description: "Switch harness", source: "extension" },
      { name: "pico-help", description: "Command directory", source: "extension" },
    ], "zh");

    const rendered = renderHelpDirectory(catalog, "zh");
    expect(rendered).toContain("Picode 命令目录");
    expect(rendered).toContain("/pico-help <命令|分类|all>");
    expect(rendered).toContain("会话与导航");
    expect(rendered).toContain("Harness 与上下文");
    expect(rendered).toContain("/harness [simple|standard|tdd]");
    expect(rendered).toContain("/compact");
  });

  it("opens a category and command selector when called without arguments", async () => {
    const commands = new Map<string, {
      description?: string;
      handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
    }>();
    const pi = {
      registerCommand(name: string, command: {
        description?: string;
        handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
      }) {
        commands.set(name, command);
      },
      getCommands() {
        return [...commands].map(([name, command]) => ({
          name,
          description: command.description,
          source: "extension" as const,
          sourceInfo: { source: "extension" as const },
        }));
      },
    } as unknown as ExtensionAPI;
    const select = vi.fn()
      .mockResolvedValueOnce("Harness 与上下文")
      .mockResolvedValueOnce("/harness — 切换开发档位与验证强度");
    const notify = vi.fn();
    pi.registerCommand("harness", {
      description: "Switch harness",
      handler: async () => {},
    });
    registerPicoHelpCommand(pi, "zh");

    await commands.get("pico-help")?.handler("", {
      ui: { select, notify },
    } as unknown as ExtensionCommandContext);

    expect(select).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("/harness [simple|standard|tdd]"),
      "info",
    );
  });
});
