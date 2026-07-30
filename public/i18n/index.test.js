import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatDate, formatNumber, getLocale, parseLanguagePack, setLocale } from "./index.js";

describe("XML localization", () => {
  const englishXml = readFileSync(resolve("public/i18n/locales/en-US.xml"), "utf8");
  const chineseXml = readFileSync(resolve("public/i18n/locales/zh-CN.xml"), "utf8");

  it("parses the versioned XML language pack", () => {
    const pack = parseLanguagePack(`
      <languagePack version="1" locale="zh-CN">
        <messages><message id="common.save">保存</message></messages>
      </languagePack>
    `);
    expect(pack.locale).toBe("zh-CN");
    expect(pack.messages.get("common.save")).toBe("保存");
  });

  it("rejects unknown pack versions and duplicate message ids", () => {
    expect(() => parseLanguagePack('<languagePack version="2" locale="en-US" />')).toThrow(
      "Unsupported XML language pack format",
    );
    expect(() =>
      parseLanguagePack(`
        <languagePack version="1" locale="en-US"><messages>
          <message id="same">one</message><message id="same">two</message>
        </messages></languagePack>
      `),
    ).toThrow("Duplicate or empty message id");
  });

  it("uses the application locale instead of the Windows locale", () => {
    expect(getLocale()).toBe("en-US");
    expect(formatNumber(3550, { notation: "compact", maximumFractionDigits: 1 })).toBe("3.6K");
    expect(formatDate("2026-05-18T10:00:00.000Z", { month: "short", timeZone: "UTC" })).toBe("May");
  });

  it("keeps the built-in English and Chinese packs structurally complete", () => {
    const english = parseLanguagePack(englishXml);
    const chinese = parseLanguagePack(chineseXml);
    expect([...chinese.messages.keys()].sort()).toEqual([...english.messages.keys()].sort());
    expect([...english.messages.values()].every(Boolean)).toBe(true);
    expect([...chinese.messages.values()].every(Boolean)).toBe(true);
  });

  it("covers every translatable string in the main HTML shell", () => {
    const english = parseLanguagePack(englishXml);
    const knownSources = new Set([...english.messages.values()].map(normalizeText));
    const html = readFileSync(resolve("public/index.html"), "utf8");
    const shell = new DOMParser().parseFromString(html, "text/html");
    const uncovered = new Set();
    const skippedTags = new Set(["CODE", "SCRIPT", "STYLE", "SVG"]);
    const walker = shell.createTreeWalker(shell.body, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      const value = normalizeText(walker.currentNode.nodeValue);
      if (
        value &&
        value !== "‹" &&
        !skippedTags.has(parent?.tagName) &&
        !parent?.closest("[data-i18n-ignore]") &&
        !knownSources.has(value)
      ) {
        uncovered.add(value);
      }
    }

    for (const element of shell.querySelectorAll("[aria-label], [placeholder], [title]")) {
      if (element.closest("[data-i18n-ignore]")) continue;
      for (const attribute of ["aria-label", "placeholder", "title"]) {
        const value = normalizeText(element.getAttribute(attribute));
        if (value && !knownSources.has(value)) uncovered.add(value);
      }
    }
    expect([...uncovered].sort()).toEqual([]);
  });

  it("switches text and attributes immediately and can restore English", async () => {
    const root = document.createElement("main");
    root.innerHTML = '<span>Settings</span><input placeholder="Search...">';
    document.body.appendChild(root);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => ({
        ok: true,
        text: async () => (String(url).includes("zh-CN") ? chineseXml : englishXml),
      })),
    );

    await setLocale("zh-CN", root);
    expect(root.querySelector("span").textContent).toBe("设置");
    expect(root.querySelector("input").placeholder).toBe("搜索…");
    expect(document.documentElement.lang).toBe("zh-CN");

    await setLocale("en-US", root);
    expect(root.querySelector("span").textContent).toBe("Settings");
    expect(root.querySelector("input").placeholder).toBe("Search...");

    root.remove();
    localStorage.removeItem("picot:locale");
    vi.unstubAllGlobals();
  });
});

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}
