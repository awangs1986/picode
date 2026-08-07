import type { PicodeEvent } from "./events.ts";

/**
 * 内部事件总线（MODULES.md §1 依赖纪律：模块间接口通信 +
 * 一条内部事件总线做生命周期通知）。调试面的 SSE 也从这里转发。
 */
export type BusListener = (event: PicodeEvent) => void;

export class EventBus {
  private listeners = new Set<BusListener>();

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: PicodeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听者异常不得影响发布者与其他监听者
      }
    }
  }
}
