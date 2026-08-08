import { existsSync, readFileSync, renameSync } from "node:fs";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
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
      const value = this.parse(this.path);
      // Seed recovery metadata for state written by older Picode versions.
      // This makes the first successful V3 read a safe migration boundary.
      const knownGood = `${this.path}.known-good`;
      try {
        if (!existsSync(knownGood)) atomicWriteFile(knownGood, this.serialize(value));
      } catch {
        // A read-only but valid state file must remain readable. The next
        // successful write will create the recovery copy through write().
      }
      return ok(value);
    } catch (cause) {
      const knownGood = `${this.path}.known-good`;
      try {
        const recovered = this.parse(knownGood);
        renameSync(this.path, `${this.path}.quarantine-${Date.now()}`);
        atomicWriteFile(this.path, this.serialize(recovered));
        return ok(recovered);
      } catch {
        // Preserve an unreadable file for diagnosis instead of repeatedly
        // ignoring it on every boot. Defaults may be used by the caller, but
        // the bad input remains recoverable from quarantine.
        try {
          if (existsSync(this.path)) renameSync(this.path, `${this.path}.quarantine-${Date.now()}`);
        } catch {
          // The original read error remains the actionable failure.
        }
        return err("store/state-unreadable", `cannot read state: ${this.path}`, cause);
      }
    }
  }

  async write(value: T): Promise<Result<void>> {
    if (!this.validate(value)) return err("store/state-invalid", `state schema rejected: ${this.path}`);
    try {
      await withFileLock(`${this.path}.lock`, () => {
        const serialized = this.serialize(value);
        atomicWriteFile(this.path, serialized);
        atomicWriteFile(`${this.path}.known-good`, serialized);
      });
      return ok(undefined);
    } catch (cause) {
      return err("store/state-write-failed", `cannot write state: ${this.path}`, cause);
    }
  }

  private parse(path: string): T {
    const text = readFileSync(path, "utf8");
    const value: unknown = this.codec.parse?.(text) ?? JSON.parse(text);
    if (!this.validate(value)) throw new Error(`state schema rejected: ${path}`);
    return value;
  }

  private serialize(value: T): string {
    return this.codec.serialize?.(value) ?? JSON.stringify(value, null, 2);
  }
}
