import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configureSubagentsForSession } from "../../src/extension/subagent-config.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("configureSubagentsForSession", () => {
  it("keeps simple free of automatic review and preserves the selected subagent model", async () => {
    await withTempPicodeDir(async (dir) => {
      const result = await configureSubagentsForSession({
        harnessTier: "simple",
        agentDir: dir,
        defaultModel: "openai/gpt-5-mini",
      });
      expect(result.ok).toBe(true);
      const settings = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8"));
      expect(settings.subagents).toMatchObject({
        defaultModel: "openai/gpt-5-mini",
        watchdog: { enabled: false, main: { enabled: false } },
      });
      const runtime = JSON.parse(readFileSync(`${dir}/extensions/subagent/config.json`, "utf8"));
      expect(runtime).toMatchObject({ maxSubagentDepth: 1, globalConcurrencyLimit: 4 });
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
});
