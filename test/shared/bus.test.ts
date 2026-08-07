import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/shared/bus.ts";
import { makeEvent } from "../../src/shared/events.ts";

describe("EventBus", () => {
  it("delivers published events to subscribers", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    const event = makeEvent("test-kind", { foo: 1 });
    bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    bus.publish(makeEvent("first", {}));
    unsubscribe();
    bus.publish(makeEvent("second", {}));

    expect(received).toHaveLength(1);
    expect((received[0] as { kind: string }).kind).toBe("first");
  });

  it("listener exception does not block other listeners", () => {
    const bus = new EventBus();
    const second = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    bus.subscribe(() => {
      throw new Error("listener blew up");
    });
    bus.subscribe(second);

    bus.publish(makeEvent("broadcast", { n: 1 }));

    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]![0]).toMatchObject({ kind: "broadcast", payload: { n: 1 } });

    consoleSpy.mockRestore();
  });
});
