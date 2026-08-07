import { existsSync, readFileSync, renameSync } from "node:fs";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

export class StateFile<T> {
  constructor(
    readonly path: string,
    private readonly validate: (value: unknown) => value is T,
  ) {}

  async read(): Promise<Result<T>> {
    if (!existsSync(this.path)) return err("store/state-missing", `state file not found: ${this.path}`);
    try {
      return ok(this.parse(this.path));
    } catch (cause) {
      const knownGood = `${this.path}.known-good`;
      try {
        const recovered = this.parse(knownGood);
        renameSync(this.path, `${this.path}.quarantine-${Date.now()}`);
        atomicWriteFile(this.path, JSON.stringify(recovered, null, 2));
        return ok(recovered);
      } catch {
        return err("store/state-unreadable", `cannot read state: ${this.path}`, cause);
      }
    }
  }

  async write(value: T): Promise<Result<void>> {
    if (!this.validate(value)) return err("store/state-invalid", `state schema rejected: ${this.path}`);
    try {
      await withFileLock(`${this.path}.lock`, () => {
        const serialized = JSON.stringify(value, null, 2);
        atomicWriteFile(this.path, serialized);
        atomicWriteFile(`${this.path}.known-good`, serialized);
      });
      return ok(undefined);
    } catch (cause) {
      return err("store/state-write-failed", `cannot write state: ${this.path}`, cause);
    }
  }

  private parse(path: string): T {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!this.validate(value)) throw new Error(`state schema rejected: ${path}`);
    return value;
  }
}
