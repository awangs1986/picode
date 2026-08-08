import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureTunSsrfCompatibility } from "../../src/extension/web-ssrf-config.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("pi-web-access TUN/fake-IP compatibility", () => {
  it("adds only the narrow benchmark range when a public probe resolves through fake-IP", async () => {
    await withTempPicodeDir(async (dir) => {
      const path = join(dir, "web-search.json");
      writeFileSync(path, JSON.stringify({ provider: "exa", ssrf: { trustEnvProxy: false } }), "utf8");

      const result = await ensureTunSsrfCompatibility({
        configPath: path,
        lookup: vi.fn(async () => [{ address: "198.18.12.4", family: 4 }] as const),
      });

      expect(result).toMatchObject({ detected: true, changed: true, range: "198.18.0.0/15" });
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        provider: "exa",
        ssrf: { trustEnvProxy: false, allowRanges: ["198.18.0.0/15"] },
      });
    });
  });

  it("does not relax SSRF for normal public DNS or unrelated private addresses", async () => {
    await withTempPicodeDir(async (dir) => {
      for (const address of ["93.184.216.34", "10.0.0.8"]) {
        const path = join(dir, address.replaceAll(".", "-"), "web-search.json");
        const result = await ensureTunSsrfCompatibility({
          configPath: path,
          lookup: async () => [{ address, family: 4 }],
        });
        expect(result).toMatchObject({ detected: false, changed: false });
      }
    });
  });
});
