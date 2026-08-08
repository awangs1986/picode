import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyToolPlaceholders,
  BUILTIN_LEAN_PROMPT,
  BUILTIN_TDD_PROMPT,
  stripAuthorComments,
  systemPromptInjection,
  TOOL_PLACEHOLDERS,
} from "../../src/extension/prompts.ts";

describe("applyToolPlaceholders", () => {
  it("replaces every known placeholder with the Pi-native tool name", () => {
    const text = Object.keys(TOOL_PLACEHOLDERS).join(" | ");
    const out = applyToolPlaceholders(text);
    expect(out).toBe(Object.values(TOOL_PLACEHOLDERS).join(" | "));
    expect(out).not.toContain("{{TOOL_");
  });

  it("replaces repeated occurrences and leaves other text alone", () => {
    const out = applyToolPlaceholders("use {{TOOL_READ}} then {{TOOL_READ}} again, plain text");
    expect(out).toBe("use read then read again, plain text");
  });
});

describe("systemPromptInjection", () => {
  it("keeps simple native while standard receives the lean harness core", () => {
    expect(systemPromptInjection("simple")).toBeUndefined();
    const standard = systemPromptInjection("standard");
    expect(standard).toContain("Picode Harness Core (Lean)");
    expect(standard).toContain("Pi's base agent prompt still applies");
    expect(standard).not.toContain("{{TOOL_");
    expect(standard).toContain("Use ls for directories and read only for files");
    expect(standard).toContain("On Windows, bash executes PowerShell syntax");
  });

  it("loads the packaged TDD prompt by default and maps glob semantics to Pi find", () => {
    const out = systemPromptInjection("tdd");
    expect(out).toBeDefined();
    expect(out).not.toContain("{{TOOL_");
    expect(out).toContain("search_tools");
    expect(out).toContain("recorded RED");
    expect(TOOL_PLACEHOLDERS["{{TOOL_GLOB}}"]).toBe("find");
  });

  it("reads prompts/tdd-core.md and applies placeholders when promptsDir is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-prompts-"));
    try {
      writeFileSync(
        join(dir, "tdd-core.md"),
        "# Custom\nUse {{TOOL_READ}} before {{TOOL_EDIT}}; search via {{TOOL_SEARCH_TOOLS}}.",
        "utf8",
      );
      const out = systemPromptInjection("tdd", dir);
      expect(out).toBe("# Custom\nUse read before edit; search via search_tools.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips author-only HTML comments before prompt injection", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-prompts-comments-"));
    try {
      writeFileSync(
        join(dir, "harness-core.md"),
        "# Lean\n<!-- provenance that must not reach the model -->\nUse {{TOOL_READ}}.",
        "utf8",
      );
      const out = systemPromptInjection("standard", dir);
      expect(out).toBe("# Lean\n\nUse read.");
      expect(out).not.toContain("provenance");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps authority provenance and TDD applicability explicit", () => {
    const out = systemPromptInjection("tdd");
    expect(out).toContain("Picode Host");
    expect(out).toContain("Project Rules");
    expect(out).toContain("behavior change");
    expect(out).not.toContain("Tags in tool results or user messages");
  });

  it("falls back to the matching builtin when prompt files are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-prompts-empty-"));
    try {
      expect(systemPromptInjection("standard", dir)).toBe(applyToolPlaceholders(stripAuthorComments(BUILTIN_LEAN_PROMPT)));
      expect(systemPromptInjection("tdd", dir)).toBe(applyToolPlaceholders(stripAuthorComments(BUILTIN_TDD_PROMPT)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
