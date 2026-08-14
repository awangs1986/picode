import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeRegistry } from "../../src/engine/worktree.ts";
import { dataPaths } from "../../src/shared/paths.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("WorktreeRegistry", () => {
  it("recovers known-good writer ownership and quarantines later corruption", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      expect((await registry.claimWriter("ws-1", "task-a", { persistent: true })).ok).toBe(true);
      const path = join(dataPaths.tasks(), "worktrees.json");
      expect(existsSync(`${path}.known-good`)).toBe(true);
      writeFileSync(path, "{broken", "utf8");

      const conflict = await new WorktreeRegistry().claimWriter("ws-1", "task-b", { persistent: true });

      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.code).toBe("engine/workspace-has-writer");
      expect(readdirSync(dataPaths.tasks()).some((name) => name.startsWith("worktrees.json.quarantine-"))).toBe(true);
    });
  });

  it("refuses writer claims when the registry authority is corrupt", async () => {
    await withTempPicodeDir(async () => {
      mkdirSync(dataPaths.tasks(), { recursive: true });
      writeFileSync(join(dataPaths.tasks(), "worktrees.json"), "{broken", "utf8");
      const registry = new WorktreeRegistry();

      const result = await registry.claimWriter("ws-1", "task-a");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("engine/worktree-registry-io");
    });
  });

  it("claimWriter succeeds on first claim", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      const r = await registry.claimWriter("ws-1", "task-a");
      expect(r.ok).toBe(true);
    });
  });

  it("claimWriter is idempotent for the same task", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      expect((await registry.claimWriter("ws-1", "task-a")).ok).toBe(true);
      expect((await registry.claimWriter("ws-1", "task-a")).ok).toBe(true);
    });
  });

  it("rejects claim when another live task holds the workspace writer", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      expect((await registry.claimWriter("ws-1", "task-a")).ok).toBe(true);

      const r = await registry.claimWriter("ws-1", "task-b");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("engine/workspace-has-writer");
    });
  });

  it("allows new task to take over stale writer with dead pid", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      const tasksDir = dataPaths.tasks();
      mkdirSync(tasksDir, { recursive: true });
      const filePath = join(tasksDir, "worktrees.json");
      writeFileSync(
        filePath,
        JSON.stringify(
          {
            version: 1,
            writers: [
              {
                workspaceId: "ws-1",
                taskId: "stale-task",
                pid: 999999,
                claimedAt: new Date().toISOString(),
              },
            ],
            managed: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const r = await registry.claimWriter("ws-1", "task-new");
      expect(r.ok).toBe(true);
      const writers = registry.list().writers.filter((w) => w.workspaceId === "ws-1");
      expect(writers).toHaveLength(1);
      expect(writers[0]!.taskId).toBe("task-new");
      expect(writers[0]!.pid).toBe(process.pid);
    });
  });

  it("hides stale short-lived writers and refreshes ownership when the same task resumes", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      mkdirSync(dataPaths.tasks(), { recursive: true });
      const filePath = join(dataPaths.tasks(), "worktrees.json");
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        writers: [{
          workspaceId: "ws-1",
          taskId: "task-a",
          pid: 999999,
          claimedAt: "2026-01-01T00:00:00.000Z",
        }],
        managed: [],
      }), "utf8");

      expect(registry.list().writers).toEqual([]);
      expect((await registry.claimWriter("ws-1", "task-a")).ok).toBe(true);
      expect(registry.list().writers).toEqual([
        expect.objectContaining({ workspaceId: "ws-1", taskId: "task-a", pid: process.pid }),
      ]);
    });
  });

  it("keeps an explicit CLI lease authoritative after its claimant process is gone", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      expect((await registry.claimWriter("ws-1", "task-a", { persistent: true })).ok).toBe(true);
      const saved = JSON.parse(JSON.stringify(registry.list())) as { writers: Array<{ pid: number; persistent?: boolean }> };
      saved.writers[0]!.pid = 999999;
      writeFileSync(join(dataPaths.tasks(), "worktrees.json"), JSON.stringify(saved), "utf8");

      const conflict = await registry.claimWriter("ws-1", "task-b", { persistent: true });
      expect(conflict.ok).toBe(false);
      expect((await registry.releaseWriter("ws-1", "task-a")).ok).toBe(true);
      expect((await registry.claimWriter("ws-1", "task-b", { persistent: true })).ok).toBe(true);
    });
  });

  it("allows another task to claim after releaseWriter", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      expect((await registry.claimWriter("ws-1", "task-a")).ok).toBe(true);
      expect((await registry.releaseWriter("ws-1", "task-a")).ok).toBe(true);

      const r = await registry.claimWriter("ws-1", "task-b");
      expect(r.ok).toBe(true);
      expect(registry.list().writers.find((w) => w.workspaceId === "ws-1")?.taskId).toBe(
        "task-b",
      );
    });
  });

  it("registerManagedWorktree sets branch picode/<taskId> and state active", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      const r = await registry.registerManagedWorktree("ws-1", "task-42", "/tmp/wt-42");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.branch).toBe("picode/task-42");
      expect(r.value.state).toBe("active");
      expect(r.value.path).toBe("/tmp/wt-42");
    });
  });

  it("completeManagedWorktree marks active record completed", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      await registry.registerManagedWorktree("ws-1", "task-42", "/tmp/wt-42");

      const r = await registry.completeManagedWorktree("task-42");
      expect(r.ok).toBe(true);
      const record = registry.list().managed.find((m) => m.taskId === "task-42");
      expect(record?.state).toBe("completed");
    });
  });

  it("completeManagedWorktree returns engine/worktree-unknown for missing active record", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      const r = await registry.completeManagedWorktree("missing-task");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("engine/worktree-unknown");
    });
  });

  it("completed managed worktree remains in list()", async () => {
    await withTempPicodeDir(async () => {
      const registry = new WorktreeRegistry();
      await registry.registerManagedWorktree("ws-1", "task-42", "/tmp/wt-42");
      await registry.completeManagedWorktree("task-42");

      const managed = registry.list().managed;
      expect(managed.some((m) => m.taskId === "task-42" && m.state === "completed")).toBe(true);
    });
  });
});
