import { t } from "../i18n/index.js";

const ICON_PATHS = {
  pin: '<path d="M9 3l6 6"></path><path d="M11 5l4-2 4 4-2 4"></path><path d="M5 11l8 8"></path><path d="M3 21l6-6"></path>',
  rename: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"></path>',
  unread:
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path><circle cx="19" cy="5" r="2"></circle>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>',
  id: '<path d="M10 3L8 21"></path><path d="M16 3l-2 18"></path><path d="M4 9h16"></path><path d="M3 15h16"></path>',
  transcript: '<path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h10"></path>',
  fork: '<path d="M6 3v5a4 4 0 0 0 4 4h8"></path><path d="M14 8l4 4-4 4"></path><circle cx="6" cy="3" r="2"></circle>',
  archive:
    '<rect x="3" y="4" width="18" height="4" rx="1"></rect><path d="M5 8v11h14V8"></path><path d="M10 12h4"></path>',
  remove:
    '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 15h10l1-15"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>',
};

function menuIcon(name) {
  return `<span class="context-menu-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${ICON_PATHS[name] || ""}</svg></span>`;
}

export class SessionContextMenu {
  constructor({ onError = null } = {}) {
    this.element = null;
    this.onError = onError;
  }

  show(event, model) {
    event.preventDefault();
    event.stopPropagation();
    this.close();

    const menu = document.createElement("div");
    menu.className = "session-context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", t("sidebar.chatActions", {}, "Chat actions"));

    for (const item of this.items(model)) {
      if (item.separator) {
        const separator = document.createElement("div");
        separator.className = "context-menu-separator";
        separator.setAttribute("role", "separator");
        menu.appendChild(separator);
      } else {
        menu.appendChild(this.buildItem(item));
      }
    }

    document.body.appendChild(menu);
    this.position(menu, event.clientX, event.clientY);
    menu.addEventListener("keydown", (keyEvent) => this.handleKeyDown(keyEvent, menu));
    this.element = menu;
  }

  items(model) {
    return [
      {
        id: "pin",
        icon: "pin",
        label: model.pinned ? t("sidebar.unpin", {}, "Unpin") : t("sidebar.pin", {}, "Pin"),
        action: model.onTogglePin,
      },
      {
        id: "rename",
        icon: "rename",
        label: t("sidebar.rename", {}, "Rename"),
        action: model.onRename,
      },
      {
        id: "unread",
        icon: "unread",
        label: model.unread
          ? t("sidebar.markAsRead", {}, "Mark as Read")
          : t("sidebar.markAsUnread", {}, "Mark as Unread"),
        action: model.onToggleUnread,
      },
      {
        id: "copy",
        icon: "copy",
        label: t("sidebar.copy", {}, "Copy"),
        submenu: [
          {
            id: "copy-id",
            icon: "id",
            label: t("sidebar.copyId", {}, "Copy ID"),
            action: model.onCopyId,
          },
          {
            id: "copy-transcript",
            icon: "transcript",
            label: t("sidebar.copyTranscript", {}, "Copy Transcript"),
            action: model.onCopyTranscript,
          },
        ],
      },
      {
        id: "fork",
        icon: "fork",
        label: t("sidebar.fork", {}, "Fork"),
        action: model.onFork,
      },
      { separator: true },
      {
        id: "archive",
        icon: "archive",
        label: model.archived
          ? t("sidebar.unarchiveChat", {}, "Unarchive")
          : t("sidebar.archiveChat", {}, "Archive"),
        action: model.onToggleArchive,
      },
      {
        id: "remove",
        icon: "remove",
        label: t("sidebar.remove", {}, "Remove"),
        dangerous: true,
        disabled: !model.canRemove,
        title: model.running
          ? t("sidebar.removeRunningDisabled", {}, "Stop the running task before removing it")
          : "",
        action: model.onRemove,
      },
    ];
  }

  buildItem(item) {
    const host = document.createElement(item.submenu ? "div" : "button");
    host.className = item.submenu ? "context-menu-submenu-host" : "context-menu-item";

    const row = item.submenu ? document.createElement("button") : host;
    row.type = "button";
    row.className = item.submenu ? "context-menu-item context-menu-submenu-trigger" : row.className;
    row.dataset.contextAction = item.id;
    row.setAttribute("role", "menuitem");
    row.tabIndex = -1;
    if (item.dangerous) row.classList.add("context-menu-item--danger");
    if (item.disabled) {
      row.disabled = true;
      row.title = item.title || "";
    }
    row.insertAdjacentHTML("beforeend", menuIcon(item.icon));
    const label = document.createElement("span");
    label.className = "context-menu-label";
    label.textContent = item.label;
    row.appendChild(label);

    if (item.submenu) return this.attachSubmenu(host, row, item.submenu);

    row.addEventListener("click", (event) => {
      event.stopPropagation();
      if (item.disabled) return;
      this.close();
      Promise.resolve(item.action()).catch((error) => this.reportError(error));
    });
    return host;
  }

  attachSubmenu(host, row, items) {
    const arrow = document.createElement("span");
    arrow.className = "context-menu-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    row.appendChild(arrow);
    row.setAttribute("aria-haspopup", "menu");
    row.setAttribute("aria-expanded", "false");

    const submenu = document.createElement("div");
    submenu.className = "session-context-submenu";
    submenu.setAttribute("role", "menu");
    for (const child of items) submenu.appendChild(this.buildItem(child));

    const setOpen = (open) => {
      host.classList.toggle("open", open);
      row.setAttribute("aria-expanded", String(open));
    };
    host.addEventListener("mouseenter", () => setOpen(true));
    host.addEventListener("mouseleave", () => setOpen(false));
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(!host.classList.contains("open"));
    });
    host.append(row, submenu);
    return host;
  }

  position(menu, clientX, clientY) {
    const rect = menu.getBoundingClientRect();
    let x = clientX;
    let y = clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    x = Math.max(8, x);
    y = Math.max(8, y);
    menu.classList.toggle("submenu-left", x + rect.width * 2 > window.innerWidth);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  handleKeyDown(event, menu) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(menu.querySelectorAll(".context-menu-item:not(:disabled)"));
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + delta + buttons.length) % buttons.length].focus();
  }

  reportError(error) {
    console.error("[Sidebar] context action failed:", error);
    this.onError?.(error);
  }

  close() {
    this.element?.remove();
    this.element = null;
  }
}
