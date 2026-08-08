import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { piAgentDir } from "../shared/paths.ts";
import { err, ok, type Result } from "../shared/types.ts";

export interface MattPocockBundleManifest {
  name: string;
  source: string;
  commit: string;
  license: string;
  skillRoot: string;
  fileCount: number;
  bundleSha256: string;
  skills: Record<string, string>;
  dependencies: Record<string, string[]>;
}

export interface SkillMaterializationReport {
  requested: string[];
  materialized: string[];
  alreadyPresent: string[];
  installRoot: string;
  commit: string;
}

const bundleRoot = fileURLToPath(new URL("../../vendor/mattpocock", import.meta.url));
const manifestPath = join(bundleRoot, "manifest.json");

export function readMattPocockBundleManifest(): Result<MattPocockBundleManifest> {
  try {
    return ok(JSON.parse(readFileSync(manifestPath, "utf8")) as MattPocockBundleManifest);
  } catch (cause) {
    return err("skills/bundle-invalid", `cannot read bundled mattpocock manifest: ${manifestPath}`, cause);
  }
}

export function bundledSkillNames(): string[] {
  const manifest = readMattPocockBundleManifest();
  return manifest.ok ? Object.keys(manifest.value.skills).sort() : [];
}

function assertSafeSkillId(skillId: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) {
    throw new Error(`invalid bundled skill id: ${skillId}`);
  }
}

function sourceDirectory(manifest: MattPocockBundleManifest, skillId: string): string {
  assertSafeSkillId(skillId);
  const relativeSource = manifest.skills[skillId];
  if (relativeSource === undefined) throw new Error(`bundled skill is not registered: ${skillId}`);
  const root = resolve(bundleRoot, manifest.skillRoot);
  const source = resolve(root, relativeSource);
  if (relative(root, source).startsWith("..") || isAbsolute(relative(root, source))) {
    throw new Error(`bundled skill escapes the bundle root: ${skillId}`);
  }
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`bundled skill is missing SKILL.md: ${skillId}`);
  }
  return source;
}

function dependencyClosure(manifest: MattPocockBundleManifest, requested: readonly string[]): string[] {
  const resolved: string[] = [];
  const visiting = new Set<string>();
  const visit = (skillId: string): void => {
    assertSafeSkillId(skillId);
    if (resolved.includes(skillId)) return;
    // The manifest may use a self-reference to make a standalone skill's
    // dependency explicit (for example `tdd: ["tdd"]`). Treat that as a
    // leaf, and reject only actual unresolved cycles through the normal
    // closure bookkeeping rather than recursing forever.
    if (visiting.has(skillId)) return;
    visiting.add(skillId);
    const dependencies = manifest.dependencies[skillId] ?? [skillId];
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(skillId);
    if (!resolved.includes(skillId)) resolved.push(skillId);
  };
  for (const skillId of requested) visit(skillId);
  return resolved;
}

/**
 * Materialize only the requested bundled skills into Picode's private Pi
 * skill root. Existing user-managed skill directories are never overwritten.
 */
export function materializeMattPocockSkills(
  requested: readonly string[],
  installRoot = join(piAgentDir(), "skills"),
): Result<SkillMaterializationReport> {
  const manifest = readMattPocockBundleManifest();
  if (!manifest.ok) return manifest;
  try {
    const skills = dependencyClosure(manifest.value, requested);
    const targetRoot = resolve(installRoot);
    mkdirSync(targetRoot, { recursive: true });
    const materialized: string[] = [];
    const alreadyPresent: string[] = [];
    for (const skillId of skills) {
      const source = sourceDirectory(manifest.value, skillId);
      const target = resolve(targetRoot, skillId);
      if (relative(targetRoot, target).startsWith("..") || isAbsolute(relative(targetRoot, target))) {
        throw new Error(`skill target escapes install root: ${skillId}`);
      }
      if (existsSync(join(target, "SKILL.md"))) {
        alreadyPresent.push(skillId);
        continue;
      }
      const staging = join(targetRoot, `.picode-${skillId}-${randomUUID()}`);
      try {
        cpSync(source, staging, { recursive: true, errorOnExist: true });
        writeFileSync(join(staging, ".picode-bundle.json"), JSON.stringify({
          bundle: manifest.value.name,
          commit: manifest.value.commit,
          skillId,
        }, null, 2), { encoding: "utf8", mode: 0o600 });
        renameSync(staging, target);
        materialized.push(skillId);
      } finally {
        if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
      }
    }
    return ok({
      requested: [...requested],
      materialized,
      alreadyPresent,
      installRoot: targetRoot,
      commit: manifest.value.commit,
    });
  } catch (cause) {
    return err("skills/materialize-failed", "cannot materialize bundled mattpocock skills", cause);
  }
}

export function mattPocockInstallRoot(): string {
  return join(piAgentDir(), "skills");
}
