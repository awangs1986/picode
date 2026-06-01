# Delete All Archived Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Delete All" trash-icon button to the Archived sessions section header that permanently removes all archived `.jsonl` session files from disk after a confirmation dialog.

**Architecture:** New `POST /api/sessions/delete-batch` endpoint in the embedded server deletes files after path-safety validation. The sidebar renders a trash SVG button in the Archived header; on click it calls `confirm()`, then the endpoint, then refreshes.

**Tech Stack:** TypeScript (embedded-server.ts), vanilla JS (session-sidebar.js), Node.js `fs.unlink`, vitest/jsdom for frontend tests.

---

## Files

| File | Action |
|------|--------|
| `extensions/embedded-server.ts` | Modify — add `POST /api/sessions/delete-batch` route |
| `public/session-sidebar.js` | Modify — add trash button to Archived header, add `deleteAllArchived()` method |
| `public/session-sidebar.test.js` | Create — vitest tests for the new button behavior |

---

### Task 1: Write failing frontend tests

**Files:**
- Create: `public/session-sidebar.test.js`

- [ ] **Step 1: Create the test file**

```js
// public/session-sidebar.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionSidebar } from './session-sidebar.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function makeSidebar(container) {
  return new SessionSidebar(container, vi.fn(), vi.fn());
}

function makeSessions(filePaths) {
  return filePaths.map((fp, i) => ({
    filePath: fp,
    name: `Session ${i}`,
    timestamp: new Date().toISOString(),
  }));
}

describe('SessionSidebar — delete all archived', () => {
  let container;
  let sidebar;

  beforeEach(() => {
    localStorage.clear();
    container = makeContainer();
    sidebar = makeSidebar(container);
    mockFetch.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it('does NOT render delete button when archived list is empty', () => {
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions(['/proj/a.jsonl']) }];
    sidebar.render();
    expect(container.querySelector('.archived-delete-all-btn')).toBeNull();
  });

  it('renders delete button when archived sessions exist', () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();
    expect(container.querySelector('.archived-delete-all-btn')).not.toBeNull();
  });

  it('calls fetch with archived paths when user confirms', async () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();

    // Mock confirm → true, fetch → success
    vi.stubGlobal('confirm', () => true);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: 1, errors: [] }) }) // delete-batch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) });           // loadSessions

    const btn = container.querySelector('.archived-delete-all-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 0)); // flush microtasks

    expect(mockFetch).toHaveBeenCalledWith('/api/sessions/delete-batch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ filePaths: [fp] }),
    }));
    vi.unstubAllGlobals();
  });

  it('does NOT call fetch when user cancels the confirm dialog', async () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();

    vi.stubGlobal('confirm', () => false);
    const btn = container.querySelector('.archived-delete-all-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 0));

    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('clears this.archived for successfully deleted paths', async () => {
    const fp = '/home/user/.pi/agent/sessions/proj/a.jsonl';
    sidebar.archived = [fp];
    sidebar.projects = [{ dirName: 'proj', path: '/proj', sessions: makeSessions([fp]) }];
    sidebar.render();

    vi.stubGlobal('confirm', () => true);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: 1, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) });

    const btn = container.querySelector('.archived-delete-all-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 10));

    expect(sidebar.archived).toEqual([]);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail**

```bash
bun run vitest run public/session-sidebar.test.js
```

Expected: tests fail because `SessionSidebar` has no `.archived-delete-all-btn` and no `deleteAllArchived` method.

---

### Task 2: Add `deleteAllArchived()` method and button to `session-sidebar.js`

**Files:**
- Modify: `public/session-sidebar.js`

- [ ] **Step 1: Add `deleteAllArchived()` method**

In `session-sidebar.js`, add this method after `toggleArchived()`:

```js
async deleteAllArchived() {
  const paths = [...this.archived];
  if (paths.length === 0) return;

  const count = paths.length;
  const ok = confirm(
    `Delete ${count} archived session${count === 1 ? '' : 's'} permanently? This cannot be undone.`
  );
  if (!ok) return;

  try {
    const res = await fetch('/api/sessions/delete-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: paths }),
    });
    const data = await res.json();
    const deleted = new Set(paths.filter(p => !(data.errors || []).includes(p)));
    this.archived = this.archived.filter(p => !deleted.has(p));
    this.saveArchived();
  } catch (err) {
    console.error('[Sidebar] deleteAllArchived failed:', err);
  }

  await this.loadSessions();
}
```

- [ ] **Step 2: Update the Archived group header in `render()` to include the trash button**

Find the block in `render()` that builds `archivedGroup` and `header`. It currently looks like:

```js
const header = document.createElement('div');
header.className = `project-header archived-header${this.archivedCollapsed ? ' collapsed' : ''}`;
header.innerHTML = `<span class="chevron">▼</span> <span>Archived</span> <span class="project-count">${archivedSessions.length}</span>`;
archivedGroup.appendChild(header);
```

Replace with:

```js
const header = document.createElement('div');
header.className = `project-header archived-header${this.archivedCollapsed ? ' collapsed' : ''}`;
header.innerHTML = `
  <span class="chevron">▼</span>
  <span>Archived</span>
  <span class="project-count">${archivedSessions.length}</span>
  <button class="archived-delete-all-btn" title="Delete all archived sessions" aria-label="Delete all archived sessions">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
    </svg>
  </button>
`;
archivedGroup.appendChild(header);

const deleteAllBtn = header.querySelector('.archived-delete-all-btn');
deleteAllBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  this.deleteAllArchived();
});
```

- [ ] **Step 3: Run the tests — confirm they pass**

```bash
bun run vitest run public/session-sidebar.test.js
```

Expected: All 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add public/session-sidebar.js public/session-sidebar.test.js
git commit -m "feat(sidebar): add deleteAllArchived method and trash button to archived header"
```

---

### Task 3: Add `POST /api/sessions/delete-batch` backend endpoint

**Files:**
- Modify: `extensions/embedded-server.ts`

- [ ] **Step 1: Add the route handler**

In `embedded-server.ts`, find the `/api/sessions/switch` POST block:

```ts
    if (urlPath === "/api/sessions/switch" && req.method === "POST") {
```

Add the following block **immediately before** it:

```ts
    if (urlPath === "/api/sessions/delete-batch" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { filePaths } = JSON.parse(body);
          if (!Array.isArray(filePaths)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePaths must be an array" }));
            return;
          }

          let deleted = 0;
          const errors: string[] = [];

          for (const fp of filePaths) {
            // Safety: must be a string, end with .jsonl, and resolve inside SESSIONS_DIR
            if (
              typeof fp !== "string" ||
              !fp.endsWith(".jsonl") ||
              !path.resolve(fp).startsWith(path.resolve(SESSIONS_DIR) + path.sep)
            ) {
              errors.push(fp);
              continue;
            }
            try {
              await fs.promises.unlink(fp);
              globalState.sessionHeaderCache.delete(fp);
              globalState.sessionMetricsCache.delete(fp);
              deleted++;
            } catch {
              errors.push(fp);
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deleted, errors }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
```

- [ ] **Step 2: Build extensions to confirm no TypeScript errors**

```bash
bun run build:extensions
```

Expected: exits 0, `dist/embedded-server.mjs` updated with no errors.

- [ ] **Step 3: Commit**

```bash
git add extensions/embedded-server.ts
git commit -m "feat(server): add POST /api/sessions/delete-batch endpoint"
```

---

### Task 4: Add CSS for the trash button

**Files:**
- Modify: `public/style.css`

- [ ] **Step 1: Add styles**

Find the `.project-new-chat-btn` rule block in `style.css` (the "+" button in project headers). Add the following rule after it:

```css
.archived-delete-all-btn {
  display: none;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
  margin-left: auto;
  color: var(--text-muted);
  border-radius: 4px;
  line-height: 0;
  flex-shrink: 0;
}

.archived-header:hover .archived-delete-all-btn {
  display: flex;
  align-items: center;
}

.archived-delete-all-btn:hover {
  color: #e53e3e;
  background: var(--hover-bg, rgba(229, 62, 62, 0.1));
}
```

- [ ] **Step 2: Run full test suite**

```bash
bun run test
```

Expected: all tests pass (vitest + tauri permissions check).

- [ ] **Step 3: Commit**

```bash
git add public/style.css
git commit -m "feat(style): add trash button styles for archived sessions header"
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Start dev server**

```bash
bun run dev
```

- [ ] **Step 2: Archive 2+ sessions** via right-click → Archive on session items in the sidebar.

- [ ] **Step 3: Hover over the "Archived" section header** — confirm the trash icon appears on the right.

- [ ] **Step 4: Click the trash icon** — confirm native confirm dialog appears with correct count, e.g. `"Delete 2 archived sessions permanently? This cannot be undone."`

- [ ] **Step 5: Click Cancel** — confirm nothing changes, sessions remain in Archived section.

- [ ] **Step 6: Click the trash icon again, then OK** — confirm:
  - Archived section disappears from sidebar
  - `localStorage.getItem('pi-studio-archived')` returns `"[]"` in browser console
  - The `.jsonl` files are gone from `~/.pi/agent/sessions/`
