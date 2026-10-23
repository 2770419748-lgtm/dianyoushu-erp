// 迁移回滚检查（口径第 24 节，CI 跑）：迁移里有删列、删表、改名、枚举值改名、改成非空、加必填列、去掉默认值、改列类型、
// 枚举加值、删类型的，必须写进 prisma/migrations-not-rollback-safe.txt（写明原因）——这些做过以后旧版本用不了，回滚脚本要据此拒绝回滚。
// 只加了枚举值的，原因写“枚举加值”开头：库里还没用到新值时回滚脚本放行（复查第 92 条），所以这一类里不能夹别的改动。
// 清单里写了、实际不存在的迁移名也报错（防写错名字）。用法：node scripts/check-migrations.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "prisma/migrations";
const LIST = "prisma/migrations-not-rollback-safe.txt";
const ENUM_ADD = "枚举加值";

// 加必填列：ADD COLUMN … NOT NULL 又没有默认值。旧版本往这张表插数据时不填这一列，插不进去（复查第 92 条）
const requiredColumn = {
  test: (sql) =>
    [...sql.matchAll(/\bADD\s+COLUMN\b([\s\S]*?)(?=,\s*(?:ADD|ALTER|DROP|RENAME)\b|;|$)/gi)].some(
      ([, def]) => /\bNOT\s+NULL\b/i.test(def) && !/\b(DEFAULT|SERIAL|BIGSERIAL|SMALLSERIAL|IDENTITY|GENERATED)\b/i.test(def),
    ),
};

const RISKY = [
  [/\bDROP\s+COLUMN\b/i, "删列"],
  [/\bDROP\s+TABLE\b/i, "删表"],
  [/\bRENAME\s+(COLUMN\s+|TO\b)/i, "改名"],
  // 枚举值改名：旧版本读到改过名的值报 not found in enum，和枚举加值一样，但库里的老数据当场就变了，不能放行
  [/\bRENAME\s+VALUE\b/i, "枚举值改名"],
  [/\bSET\s+NOT\s+NULL\b/i, "改成非空"],
  [requiredColumn, "加必填列"],
  // 去掉默认值：旧版本靠库里的默认值插数据（不填这一列），去掉以后插不进去
  [/\bDROP\s+DEFAULT\b/i, "去掉默认值"],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, "改列类型"],
  [/\bADD\s+VALUE\b/i, ENUM_ADD],
  [/\bDROP\s+TYPE\b/i, "删类型"],
];

const listed = new Map(
  readFileSync(LIST, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => [l.split(/\s+/)[0], l.slice(l.split(/\s+/)[0].length).trim()]),
);
const names = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(DIR, d.name, "migration.sql")))
  .map((d) => d.name);

const problems = [];
for (const name of names) {
  // 去掉注释（-- 到行尾）再查：注释里写“删列”之类的说明不算
  const sql = readFileSync(join(DIR, name, "migration.sql"), "utf8").replace(/--.*$/gm, "");
  const found = RISKY.filter(([re]) => re.test(sql)).map(([, label]) => label);
  const reason = listed.get(name);
  if (found.length > 0 && reason === undefined) {
    problems.push(`${name}：有${found.join("、")}，不能直接回滚，要写进 ${LIST}（迁移名 原因；只加了枚举值的原因写“${ENUM_ADD}”开头）`);
  } else if (reason?.startsWith(ENUM_ADD) && (found.length !== 1 || found[0] !== ENUM_ADD)) {
    problems.push(`${name}：原因写了“${ENUM_ADD}”开头，回滚脚本会在没用到新值时放行，但它${found.length ? `还有${found.filter((f) => f !== ENUM_ADD).join("、")}` : "里没有枚举加值"}——原因换个说法`);
  }
}
for (const name of listed.keys()) {
  if (!names.includes(name)) problems.push(`${LIST} 里的 ${name} 没有这个迁移（名字写错了？）`);
}
if (problems.length > 0) {
  console.error("迁移回滚检查不过：\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
const enumOnly = [...listed.values()].filter((r) => r.startsWith(ENUM_ADD)).length;
console.log(`迁移回滚检查：${names.length} 个迁移，${listed.size} 个标了不能直接回滚（其中 ${enumOnly} 个只加了枚举值），其余都是只加`);
