// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");

describe("model dropdown layout", () => {
  it("wraps provider choices without exposing a horizontal scrollbar", () => {
    const rule = css.match(/\.model-dropdown-provider-filters\s*\{(?<body>[^}]+)\}/)?.groups?.body;

    expect(rule).toContain("flex-wrap: wrap");
    expect(rule).toContain("overflow-x: hidden");
    expect(rule).not.toContain("overflow-x: auto");
  });

  it("keeps a dedicated model-settings action outside the scrolling model rows", () => {
    const rule = css.match(/\.model-dropdown-more\s*\{(?<body>[^}]+)\}/)?.groups?.body;

    expect(rule).toContain("flex: 0 0 auto");
    expect(rule).toContain("border-top:");
    expect(appJs).toContain('moreModelsButton.className = "model-dropdown-more"');
    expect(appJs).toContain("openConfigurationSettings().catch(() => {})");
    expect(appJs.indexOf("modelDropdownMenu.appendChild(itemsContainer)")).toBeLessThan(
      appJs.indexOf("modelDropdownMenu.appendChild(moreModelsButton)"),
    );
  });
});
