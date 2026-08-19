import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configureSubagentsForSession } from "../../src/extension/subagent-config.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("configureSubagentsForSession", () => {
  it("keeps simple free of automatic review and preserves the selected subagent model and thinking", async () => {
    await withTempPicodeDir(async (dir) => {
      const result = await configureSubagentsForSession({
        harnessTier: "simple",
        agentDir: dir,
        defaultModel: "openai/gpt-5-mini",
        defaultThinking: "high",
      });
      expect(result.ok).toBe(true);
      const settings = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8"));
      expect(settings.subagents).toMatchObject({
        defaultModel: "openai/gpt-5-mini",
        defaultThinking: "high",
        watchdog: { enabled: false, main: { enabled: false } },
      });
      const runtime = JSON.parse(readFileSync(`${dir}/extensions/subagent/config.json`, "utf8"));
      expect(runtime).toMatchObject({ maxSubagentDepth: 1, globalConcurrencyLimit: 4 });
    });
  });

  it("makes an explicit Picode selection override builtin role thinking", async () => {
    await withTempPicodeDir(async (dir) => {
      writeFileSync(`${dir}/settings.json`, JSON.stringify({
        subagents: {
          agentOverrides: {
            researcher: { description: "Keep this role description", thinking: "low" },
            custom: { thinking: "minimal" },
          },
        },
      }));

      const result = await configureSubagentsForSession({
        harnessTier: "standard",
        agentDir: dir,
        defaultModel: "openai/gpt-5.6-luna",
        defaultThinking: "high",
      });

      expect(result.ok).toBe(true);
      const settings = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8"));
      expect(settings.subagents.agentOverrides.researcher).toMatchObject({
        description: "Keep this role description",
        model: "openai/gpt-5.6-luna",
        thinking: "high",
      });
      expect(settings.subagents.agentOverrides.scout).toMatchObject({
        model: "openai/gpt-5.6-luna",
        thinking: "high",
      });
      expect(settings.subagents.agentOverrides.custom).toEqual({ thinking: "minimal" });
    });
  });

  it("falls back from the preferred subagent model to the current parent model", async () => {
    await withTempPicodeDir(async (dir) => {
      const result = await configureSubagentsForSession({
        harnessTier: "tdd",
        agentDir: dir,
        defaultModel: "openai/gpt-5.6-luna",
        defaultThinking: "high",
        fallbackModel: "openai/gpt-5.6-sol",
      });

      expect(result.ok).toBe(true);
      const settings = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8"));
      for (const role of ["reviewer", "researcher", "scout", "worker"]) {
        expect(settings.subagents.agentOverrides[role]).toMatchObject({
          model: "openai/gpt-5.6-luna",
          fallbackModels: ["openai/gpt-5.6-sol"],
          thinking: "high",
          subagentOnlyExtensions: [expect.stringMatching(/subagent-provider-entry\.ts$/u)],
        });
      }
    });
  });

  it("does not retain a stale parent fallback when the session inherits its model", async () => {
    await withTempPicodeDir(async (dir) => {
      await configureSubagentsForSession({
        harnessTier: "tdd",
        agentDir: dir,
        defaultModel: "openai/gpt-5.6-luna",
        fallbackModel: "openai/gpt-5.6-sol",
      });
      const result = await configureSubagentsForSession({
        harnessTier: "tdd",
        agentDir: dir,
      });

      expect(result.ok).toBe(true);
      const settings = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8"));
      expect(settings.subagents.defaultModel).toBeUndefined();
      expect(settings.subagents.agentOverrides?.reviewer?.model).toBeUndefined();
      expect(settings.subagents.agentOverrides?.reviewer?.fallbackModels).toBeUndefined();
    });
  });

  it("configures a bounded quick review for standard and stricter review for tdd", async () => {
    await withTempPicodeDir(async (dir) => {
      await configureSubagentsForSession({ harnessTier: "standard", agentDir: dir });
      let settings = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8"));
      expect(settings.subagents.watchdog).toMatchObject({
        enabled: true,
        main: { enabled: true },
        autoFollow: { blockers: false, maxAttempts: 1 },
      });

      await configureSubagentsForSession({ harnessTier: "tdd", agentDir: dir });
      settings = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8"));
      expect(settings.subagents.watchdog).toMatchObject({
        enabled: true,
        main: { enabled: true },
        children: { enabled: true },
        autoFollow: { blockers: true, maxAttempts: 2 },
      });
    });
  });

  it("raises the one pi-subagents concurrency ceiling for Google research, capped at ten", async () => {
    await withTempPicodeDir(async (dir) => {
      await configureSubagentsForSession({
        harnessTier: "simple",
        agentDir: dir,
        googleSearchParallelism: 10,
      });
      const runtime = JSON.parse(readFileSync(`${dir}/extensions/subagent/config.json`, "utf8"));
      expect(runtime.globalConcurrencyLimit).toBe(10);
    });
  });
});
