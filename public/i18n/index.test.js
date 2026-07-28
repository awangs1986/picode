import { describe, expect, it } from "vitest";
import { formatDate, formatNumber, getLocale, parseLanguagePack } from "./index.js";

describe("XML localization", () => {
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
});
