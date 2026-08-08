import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { piAgentDir } from "../shared/paths.ts";
import {
  materializeMattPocockSkills,
  mattPocockInstallRoot,
} from "./mattpocock-bundle.ts";
import { err, ok, type Result } from "../shared/types.ts";

const MATT_MARKER = "setup-matt-pocock-skills/SKILL.md";
const CANONICAL_SKILLS = [
  "grill-with-docs/SKILL.md",
  "grilling/SKILL.md",
  "tdd/SKILL.md",
  "domain-modeling/SKILL.md",
] as const;

export interface MattPocockDetection {
  installed: boolean;
  roots: string[];
}

export interface PlanSkillBootstrap {
  detection: MattPocockDetection;
  materialized: boolean;
}

export interface SkillRootOptions {
  home?: string;
  piAgent?: string;
  roots?: string[];
}

function projectSkillRoots(cwd: string): string[] {
  const roots: string[] = [];
  let current = resolve(cwd);
  while (true) {
    roots.push(join(current, ".agents", "skills"));
    roots.push(join(current, ".pi", "skills"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

/** Resolve the same user/project skill locations that Pi searches. */
export function skillRootsFor(cwd: string, options: SkillRootOptions = {}): string[] {
  if (options.roots !== undefined) return [...new Set(options.roots)];
  const home = options.home ?? homedir();
  const agent = options.piAgent ?? piAgentDir();
  return [...new Set([
    join(home, ".agents", "skills"),
    join(home, ".pi", "agent", "skills"),
    join(agent, "skills"),
    ...projectSkillRoots(cwd),
  ])];
}

function looksLikeMattPocockCollection(root: string): boolean {
  if (existsSync(join(root, MATT_MARKER))) return true;
  const canonicalCount = CANONICAL_SKILLS.reduce(
    (count, skill) => count + (existsSync(join(root, skill)) ? 1 : 0),
    0,
  );
  // A partial install without the setup marker must still contain more than
  // one canonical skill, otherwise an unrelated single skill is a false hit.
  return canonicalCount >= 2;
}

export function findMattPocockSkills(cwd: string, options: SkillRootOptions = {}): MattPocockDetection {
  const roots = skillRootsFor(cwd, options).filter(looksLikeMattPocockCollection);
  return { installed: roots.length > 0, roots };
}

/** Materialize the pinned planning bundle on the first explicit /plan use. */
export function ensurePlanSkills(cwd: string): Result<PlanSkillBootstrap> {
  const existing = findMattPocockSkills(cwd);
  if (existing.installed) return ok({ detection: existing, materialized: false });
  const materialized = materializeMattPocockSkills(["grill-with-docs"], mattPocockInstallRoot());
  if (!materialized.ok) return materialized;
  const detection = findMattPocockSkills(cwd);
  if (!detection.installed) {
    return err("skills/materialize-invisible", "bundled planning skills were materialized but Pi cannot discover them");
  }
  return ok({
    detection,
    materialized: materialized.value.materialized.length > 0,
  });
}

export type PlanCommandResult =
  | { kind: "missing"; message: string }
  | { kind: "ready"; message: string };

export function planCommandResult(args: string, detection: MattPocockDetection): PlanCommandResult {
  if (!detection.installed) {
    return {
      kind: "missing",
      message: [
        "Picode includes a pinned mattpocock/skills snapshot, but the current Pi session cannot discover it yet.",
        "Restart or reload Picode so the materialized planning Skills can be discovered.",
      ].join("\n"),
    };
  }
  const objective = args.trim();
  return {
    kind: "ready",
    message: [
      "Use the installed mattpocock/skills workflow for this plan.",
      "Start with the grill-with-docs flow to align the design, terminology, and ADRs before implementation.",
      ...(objective === "" ? [] : [`Planning objective: ${objective}`]),
    ].join("\n"),
  };
}
