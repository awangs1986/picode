import { beforeEach, describe, expect, test, vi } from "vitest";
import { setupAccountSettings } from "./accounts.js";

function installMarkup() {
  document.body.innerHTML = `
    <section id="settings-accounts-section">
      <button data-account-local="codex">local</button>
      <button data-account-json="codex">json</button>
      <input id="account-json-file-input" type="file" multiple>
      <div id="account-import-status" hidden></div>
      <div id="account-import-preview" hidden>
        <div id="account-import-warnings"></div>
        <div id="account-import-candidates"></div>
        <button id="account-import-cancel">cancel</button>
        <button id="account-import-confirm">confirm</button>
      </div>
      <div id="account-vault-list"></div>
    </section>`;
}

function preview(chatCompatible = true) {
  return {
    previewId: "preview-1",
    provider: "codex",
    warnings: [],
    candidates: [
      {
        candidateId: "candidate-1",
        provider: "codex",
        piProvider: "openai-codex",
        label: "me@example.com",
        authKind: "oauth",
        chatCompatible,
        warnings: [],
        metadata: {},
      },
    ],
  };
}

describe("account settings", () => {
  beforeEach(installMarkup);

  test("requires an explicit preview before applying a local account import", async () => {
    const transport = {
      capabilities: { native: true },
      listAccounts: vi.fn().mockResolvedValue([]),
      previewLocalAccountImport: vi.fn().mockResolvedValue(preview()),
      applyAccountImport: vi.fn().mockResolvedValue({
        importedIds: ["candidate-1"],
        activeAccountId: "candidate-1",
        accounts: [],
      }),
    };
    const { loadAccounts } = setupAccountSettings({ transport });
    await loadAccounts();

    document.querySelector('[data-account-local="codex"]').click();
    await vi.waitFor(() =>
      expect(transport.previewLocalAccountImport).toHaveBeenCalledWith("codex"),
    );
    expect(document.getElementById("account-import-preview").hidden).toBe(false);
    expect(transport.applyAccountImport).not.toHaveBeenCalled();

    document.getElementById("account-import-confirm").click();
    await vi.waitFor(() =>
      expect(transport.applyAccountImport).toHaveBeenCalledWith(
        "preview-1",
        ["candidate-1"],
        "candidate-1",
      ),
    );
  });

  test("never offers a Cursor Desktop-only credential as an active Pi chat account", async () => {
    const transport = {
      capabilities: { native: true },
      listAccounts: vi.fn().mockResolvedValue([]),
      previewLocalAccountImport: vi.fn().mockResolvedValue(preview(false)),
      applyAccountImport: vi.fn().mockResolvedValue({
        importedIds: ["candidate-1"],
        activeAccountId: null,
        accounts: [],
      }),
    };
    setupAccountSettings({ transport });
    document.querySelector('[data-account-local="codex"]').click();
    await vi.waitFor(() => expect(document.querySelector('input[type="radio"]')).not.toBeNull());

    expect(document.querySelector('input[type="radio"]')?.disabled).toBe(true);
    document.getElementById("account-import-confirm").click();
    await vi.waitFor(() =>
      expect(transport.applyAccountImport).toHaveBeenCalledWith("preview-1", ["candidate-1"], null),
    );
  });
});
