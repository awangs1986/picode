import { beforeEach, describe, expect, test, vi } from "vitest";
import { setupCustomProviderSettings } from "./custom-providers.js";

function markup() {
  document.body.innerHTML = `
    <button id="custom-provider-add"></button>
    <div id="custom-provider-form" class="hidden">
      <input id="custom-provider-name">
      <input id="custom-provider-id">
      <select id="custom-provider-api"><option value="openai-completions">OpenAI</option></select>
      <input id="custom-provider-base-url">
      <input id="custom-provider-api-key">
      <textarea id="custom-provider-models"></textarea>
      <div id="custom-provider-status" hidden></div>
      <button id="custom-provider-cancel"></button>
      <button id="custom-provider-discover"></button>
      <button id="custom-provider-save"></button>
    </div>`;
}

describe("custom API provider settings", () => {
  beforeEach(() => {
    markup();
    globalThis.requestAnimationFrame = (callback) => callback();
  });

  test("loads a model list without saving the API key first", async () => {
    const transport = {
      discoverCustomProviderModels: vi
        .fn()
        .mockResolvedValue({ models: ["deepseek-chat", "deepseek-reasoner"] }),
      saveCustomProvider: vi.fn(),
    };
    setupCustomProviderSettings({ transport });

    document.getElementById("custom-provider-add").click();
    const name = document.getElementById("custom-provider-name");
    name.value = "DeepSeek Cloud";
    name.dispatchEvent(new Event("input"));
    document.getElementById("custom-provider-base-url").value = "https://api.example/v1";
    document.getElementById("custom-provider-api-key").value = "secret";
    document.getElementById("custom-provider-discover").click();

    await vi.waitFor(() => expect(transport.discoverCustomProviderModels).toHaveBeenCalled());
    expect(document.getElementById("custom-provider-id").value).toBe("deepseek-cloud");
    expect(document.getElementById("custom-provider-models").value).toBe(
      "deepseek-chat\ndeepseek-reasoner",
    );
    expect(transport.saveCustomProvider).not.toHaveBeenCalled();
  });

  test("saves distinct model IDs and refreshes the chat model catalog", async () => {
    const transport = {
      discoverCustomProviderModels: vi.fn(),
      saveCustomProvider: vi.fn().mockResolvedValue({ providerId: "deepseek" }),
    };
    const onChanged = vi.fn();
    setupCustomProviderSettings({ transport, onChanged });
    document.getElementById("custom-provider-name").value = "DeepSeek";
    document.getElementById("custom-provider-id").value = "deepseek";
    document.getElementById("custom-provider-base-url").value = "https://api.example/v1";
    document.getElementById("custom-provider-api-key").value = "secret";
    document.getElementById("custom-provider-models").value =
      "deepseek-chat, deepseek-chat\ndeepseek-reasoner";

    document.getElementById("custom-provider-save").click();

    await vi.waitFor(() => expect(transport.saveCustomProvider).toHaveBeenCalled());
    expect(transport.saveCustomProvider).toHaveBeenCalledWith({
      providerId: "deepseek",
      displayName: "DeepSeek",
      api: "openai-completions",
      baseUrl: "https://api.example/v1",
      apiKey: "secret",
      modelIds: ["deepseek-chat", "deepseek-reasoner"],
    });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith("deepseek"));
    expect(document.getElementById("custom-provider-api-key").value).toBe("");
  });
});
