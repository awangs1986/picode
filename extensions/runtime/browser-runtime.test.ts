import { describe, expect, test } from "vitest";
import {
  BrowserAutomationRuntime,
  browserDownloadPlatform,
  browserExecutableCandidates,
  isRecoverableBrowserError,
  resolveBrowserExecutable,
} from "./browser-runtime";

describe("Picode browser runtime", () => {
  test("discovers platform browser candidates without requiring a bundled Chromium", () => {
    expect(browserExecutableCandidates("win32").some((value) => value.endsWith("chrome.exe"))).toBe(
      true,
    );
    expect(browserExecutableCandidates("darwin")).toContain(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(browserExecutableCandidates("linux")).toContain("/usr/bin/chromium");
  });

  test("rejects an explicitly configured browser that does not exist", () => {
    expect(() => resolveBrowserExecutable("Z:/missing/picode-browser.exe")).toThrow(
      "Browser executable does not exist",
    );
  });

  test("maps supported Chrome for Testing platforms and only recycles hard browser failures", () => {
    expect(browserDownloadPlatform("win32", "x64")).toBe("win64");
    expect(browserDownloadPlatform("darwin", "arm64")).toBe("mac-arm64");
    expect(browserDownloadPlatform("linux", "x64")).toBe("linux64");
    expect(browserDownloadPlatform("linux", "arm64")).toBeNull();
    expect(isRecoverableBrowserError(new Error("Browser code timed out after 1 seconds"))).toBe(
      true,
    );
    expect(isRecoverableBrowserError(new Error("Timed out waiting for selector: #button"))).toBe(
      false,
    );
  });

  test("opens, automates, screenshots, and closes a real local Chromium when available", async () => {
    if (!resolveBrowserExecutable()) return;
    const runtime = new BrowserAutomationRuntime();
    try {
      const opened = await runtime.execute("browser-session", {
        action: "open",
        url: "data:text/html,<title>Picode Browser Test</title><button id='go'>Ready</button>",
        timeout: 30,
      });
      expect(opened.title).toBe("Picode Browser Test");
      const result = await runtime.execute("browser-session", {
        action: "run",
        timeout: 30,
        code: `
            await tab.click("#go");
            display(await tab.extract());
            await tab.screenshot();
          `,
      });
      expect(result.text).toContain("Ready");
      expect(result.screenshots?.[0].bytes).toBeGreaterThan(100);
      const closed = await runtime.execute("browser-session", { action: "close", kill: true });
      expect(closed.text).toContain("Closed 1");
    } finally {
      await runtime.dispose();
    }
  }, 45_000);
});
