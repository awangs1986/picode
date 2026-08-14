import { existsSync } from "node:fs";
import {
  atomicWriteRecoverableFile,
  readRecoverableFile,
  withFileLock,
} from "../shared/fs.ts";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

export class StateFile<T> {
  constructor(
    readonly path: string,
    private readonly validate: (value: unknown) => value is T,
    private readonly codec: {
      parse?(text: string): unknown;
      serialize?(value: T): string;
    } = {},
  ) {}

  async read(): Promise<Result<T>> {
    return this.readSync();
  }

  readSync(): Result<T> {
    if (!existsSync(this.path)) return err("store/state-missing", `state file not found: ${this.path}`);
    try {
      return ok(readRecoverableFile(
        this.path,
        (text) => this.parseText(text),
        (value) => this.serialize(value),
      ));
    } catch (cause) {
      return err("store/state-unreadable", `cannot read state: ${this.path}`, cause);
    }
  }

  async write(value: T): Promise<Result<void>> {
    if (!this.validate(value)) return err("store/state-invalid", `state schema rejected: ${this.path}`);
    try {
      await withFileLock(`${this.path}.lock`, () => {
        const serialized = this.serialize(value);
        atomicWriteRecoverableFile(this.path, serialized);
      });
      return ok(undefined);
    } catch (cause) {
      return err("store/state-write-failed", `cannot write state: ${this.path}`, cause);
    }
  }

  private parseText(text: string): T {
    const value: unknown = this.codec.parse?.(text) ?? JSON.parse(text);
    if (!this.validate(value)) throw new Error(`state schema rejected: ${this.path}`);
    return value;
  }

  private serialize(value: T): string {
    return this.codec.serialize?.(value) ?? JSON.stringify(value, null, 2);
  }
}
