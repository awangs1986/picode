import { beforeEach, describe, expect, test, vi } from "vitest";
import "./harness-review.js";

describe("Harness review", () => {
  beforeEach(() => {
    document.body.innerHTML = "<picode-harness-review></picode-harness-review>";
  });

  test("requires explicit candidate selection and can run only confirmed actions", async () => {
    const panel = document.querySelector("picode-harness-review");
    const transport = {
      reviewHarness: vi.fn(async () => ({
        taskId: "task-a",
        profileExists: false,
        candidates: [
          { id: "package.test", command: "vitest", source: "package.json", trusted: false },
          { id: "package.build", command: "vite build", source: "package.json", trusted: false },
        ],
      })),
      confirmHarness: vi.fn(async () => ({
        profile: { actions: [{ id: "package.test", risk: "readOnly" }] },
      })),
      runHarnessAction: vi.fn(async () => ({ passed: true, execution: { stdout: "ok" } })),
    };
    panel.transport = transport;
    await panel.open({ id: "task-a" });

    expect([...panel.querySelectorAll("input[type=checkbox]")]).toHaveLength(2);
    expect(panel.querySelector("[data-confirm]").disabled).toBe(true);
    panel.querySelector('input[value="package.test"]').click();
    panel.querySelector("[data-confirm]").click();
    await vi.waitFor(() =>
      expect(transport.confirmHarness).toHaveBeenCalledWith("task-a", ["package.test"]),
    );
    panel.querySelector("[data-run-action]").click();
    await vi.waitFor(() =>
      expect(transport.runHarnessAction).toHaveBeenCalledWith("task-a", "package.test", {}, false),
    );
    expect(panel.textContent).toContain("ok");
  });
});
