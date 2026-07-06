/**
 * <chat-settings-panel> Web Component
 *
 * The "Chat" tab inside Settings.
 * Replaces setupChatSettings() in app.js.
 *
 * Usage:
 *   <chat-settings-panel data-settings-panel="chat"></chat-settings-panel>
 *
 * Loads config from  GET /api/chat-config  → { content: string }
 * Saves config via   PUT /api/chat-config  ← { content: string }
 */

class ChatSettingsPanel extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="settings-header"><h3>Chat</h3></div>
      <div class="settings-body">
        <div class="settings-section">
          <div class="settings-section-title">Accounts</div>
          <p class="settings-help">
            Configure Telegram bots.
            Config stored in <code>~/.pi/agent/chat/config.json</code>.
          </p>
          <div class="chat-accounts-list" data-accounts-list></div>
          <button class="sa-btn sa-btn-approve" data-action="add-telegram" style="margin-top:8px">
            + Add Telegram
          </button>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Raw Config</div>
          <textarea class="config-editor-textarea settings-config-textarea"
            data-textarea spellcheck="false" autocomplete="off"
            autocorrect="off" autocapitalize="off" placeholder="Loading…"></textarea>
          <div class="settings-config-actions">
            <div class="config-editor-error settings-save-status hidden" data-error></div>
            <div class="settings-config-button-group">
              <button class="btn-primary" data-action="save">Save</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this._textarea = this.querySelector("[data-textarea]");
    this._errorEl = this.querySelector("[data-error]");
    this._accountsEl = this.querySelector("[data-accounts-list]");

    this.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "save") this._save();
      if (action === "add-telegram") this._addTelegram();
    });

    // Load when the Chat settings tab becomes visible
    document.querySelectorAll(".settings-nav-item").forEach((btn) => {
      if (btn.dataset.settingsTab === "chat") {
        btn.addEventListener("click", () => this._load());
      }
    });
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async _load() {
    try {
      const res = await fetch("/api/chat-config");
      if (!res.ok) return;
      const { content } = await res.json();
      this._textarea.value = content || "{}";
      this._renderAccounts(content);
    } catch {}
  }

  async _save() {
    const content = this._textarea.value;
    try {
      JSON.parse(content);
    } catch {
      this._showError("Invalid JSON");
      return;
    }
    this._clearError();
    const saveBtn = this.querySelector('[data-action="save"]');
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/chat-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Save failed");
      this._renderAccounts(content);
    } catch (e) {
      this._showError(String(e));
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Account wizards ───────────────────────────────────────────────────────

  _addTelegram() {
    const botToken = window.prompt("Telegram Bot Token\n\nGet one from @BotFather on Telegram:");
    if (!botToken?.trim()) return;
    const chatId = window.prompt(
      "Allowed Chat ID\n\nYour personal user ID or a group/channel chat ID.\n" +
        "(Leave blank to allow any chat — not recommended for production):",
    );
    try {
      const config = JSON.parse(this._textarea.value || "{}");
      const id = `telegram-${Date.now()}`;
      config.accounts = config.accounts || {};
      const channels = {};
      if (chatId?.trim()) {
        const cid = chatId.trim();
        channels[cid] = { id: cid };
      }
      config.accounts[id] = {
        service: "telegram",
        name: "Telegram",
        botToken: botToken.trim(),
        channels,
      };
      this._textarea.value = JSON.stringify(config, null, 2);
      this._showSuccess("Token added — click Save to write to disk.");
    } catch {}
  }

  // ── Render accounts list ──────────────────────────────────────────────────

  _renderAccounts(rawContent) {
    try {
      const config = JSON.parse(rawContent || "{}");
      const accounts = Object.entries(config.accounts || {});
      if (accounts.length === 0) {
        this._accountsEl.innerHTML = `<p class="settings-help">No accounts configured.</p>`;
        return;
      }
      this._accountsEl.innerHTML = accounts
        .map(
          ([id, acc]) => `
        <div class="chat-account-card">
          <div class="chat-account-header">
            <span class="chat-account-name">${esc(acc.name || id)}</span>
            <span class="chat-account-service">${esc(acc.service)}</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim)">
            ${Object.keys(acc.channels || {}).length} channel(s)
          </div>
        </div>
      `,
        )
        .join("");
    } catch {
      this._accountsEl.innerHTML = "";
    }
  }

  // ── Error / success helpers ───────────────────────────────────────────────

  _showError(msg) {
    this._errorEl.textContent = msg;
    this._errorEl.style.color = "";
    this._errorEl.classList.remove("hidden");
  }

  _showSuccess(msg) {
    this._errorEl.textContent = msg;
    this._errorEl.style.color = "var(--color-success, #4ade80)";
    this._errorEl.classList.remove("hidden");
  }

  _clearError() {
    this._errorEl.classList.add("hidden");
  }
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

customElements.define("chat-settings-panel", ChatSettingsPanel);
