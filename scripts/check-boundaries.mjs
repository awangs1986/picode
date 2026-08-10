#!/usr/bin/env node
/**
 * 模块依赖方向检查（PICODE-V3-DESIGN.md §3.6，Q9 单包 + 目录边界）：
 * - shared 只能 import shared；
 * - 四个领域模块（store/engine/guard/devloop）只能 import shared 和自己；
 *   跨模块协作经 shared 里的接口类型 + 组合根注入；
 * - extension/、control/、api/ 与 serve/ 是允许 import 全部模块的适配/组合层。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SRC = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "src");
const DOMAIN = ["store", "engine", "guard", "devloop"];
const COMPOSITION = ["extension", "control", "api", "serve"];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function moduleOf(filePath) {
  return relative(SRC, filePath).split(sep)[0];
}

const violations = [];

for (const file of walk(SRC)) {
  const from = moduleOf(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = resolve(join(file, "..", match[1]));
    if (!target.startsWith(SRC)) continue;
    const to = moduleOf(target);
    if (from === to) continue;
    const allowed =
      (from === "shared" && to === "shared") ||
      (DOMAIN.includes(from) && to === "shared") ||
      COMPOSITION.includes(from);
    if (!allowed) {
      violations.push(`${relative(SRC, file)} -> ${to} (import "${match[1]}")`);
    }
  }
}

if (violations.length > 0) {
  console.error("boundary violations:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("module boundaries OK");
