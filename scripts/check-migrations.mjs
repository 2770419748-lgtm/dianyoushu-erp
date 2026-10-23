// 迁移回滚检查（口径第 24 节，CI 跑）：迁移里有删列、删表、改名、改成非空、改列类型、枚举加值、删类型的，
// 必须写进 prisma/migrations-not-rollback-safe.txt（写明原因）——这些做过以后旧版本用不了，回滚脚本要据此拒绝回滚。
// 清单里写了、实际不存在的迁移名也报错（防写错名字）。用法：node scripts/check-migrations.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "prisma/migrations";
const LIST = "prisma/migrations-not-rollback-safe.txt";
const RISKY = [
  [/\bDROP\s+COLUMN\b/i, "删列"],
  [/\bDROP\s+TABLE\b/i, "删表"],
  [/\bRENAME\s+(COLUMN\s+|TO\b)/i, "改名"],
  [/\bSET\s+NOT\s+NULL\b/i, "改成非空"],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, "改列类型"],
  [/\bADD\s+VALUE\b/i, "枚举加值"],
  [/\bDROP\s+TYPE\b/i, "删类型"],
];

const listed = new Map(
  readFileSync(LIST, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => [l.split(/\s+/)[0], l]),
);
const names = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(DIR, d.name, "migration.sql")))
  .map((d) => d.name);

const problems = [];
for (const name of names) {
  // 去掉注释（-- 到行尾）再查：注释里写“删列”之类的说明不算
  const sql = readFileSync(join(DIR, name, "migration.sql"), "utf8").replace(/--.*$/gm, "");
  const found = RISKY.filter(([re]) => re.test(sql)).map(([, label]) => label);
  if (found.length > 0 && !listed.has(name)) problems.push(`${name}：有${found.join("、")}，不能直接回滚，要写进 ${LIST}（迁移名 原因）`);
}
for (const name of listed.keys()) {
  if (!names.includes(name)) problems.push(`${LIST} 里的 ${name} 没有这个迁移（名字写错了？）`);
}
if (problems.length > 0) {
  console.error("迁移回滚检查不过：\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log(`迁移回滚检查：${names.length} 个迁移，${listed.size} 个标了不能直接回滚，其余都是只加`);
