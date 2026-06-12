import { beforeEach, describe, expect, it } from "vitest";
import { MessageRenderer } from "./message-renderer.js";

describe("MessageRenderer streaming markdown preview", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("renders markdown live during streaming updates", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "hello **bold te");

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold te</strong>");
  });

  it("finalizes from the raw text, not the rendered DOM", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "a **bold** word and `code`");
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold</strong>");
    expect(content.innerHTML).toContain("<code>code</code>");
  });

  it("keeps a partial code block previewing as a code block", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "```js\nconst a = 1;");

    const content = el.querySelector(".message-content");
    expect(content.querySelector(".code-block-wrapper")).not.toBeNull();
    expect(content.textContent).toContain("const a = 1;");
  });

  it("preserves the thinking block while streaming text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, "pondering...");
    renderer.updateStreamingMessage(el, "some *italic");

    expect(el.querySelector(".streaming-thinking")).not.toBeNull();
    expect(el.querySelector(".streaming-text").innerHTML).toContain("<em>italic</em>");
  });

  it("does not render raw HTML from streamed text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "`<script>alert(1)</script>`");

    const content = el.querySelector(".message-content");
    expect(content.querySelector("script")).toBeNull();
  });
});
