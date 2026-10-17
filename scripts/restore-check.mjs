// 恢复演练：把一份备份恢复进一个临时数据库，逐表对比行数，对上了再把临时库删掉。
// 不碰正在用的库。“备份能不能用”只有真恢复一次才知道，所以每次改表结构后都跑一次。
// 用法：pnpm db:restore-check            （用最新一份备份）
//       pnpm db:restore-check 某个.dump   （指定备份文件）
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKUP_DIR, connection, runPg } from "./pg-tools.mjs";

const conn = connection();
const arg = process.argv[2];
const file = arg
  ? resolve(arg)
  : (() => {
      const list = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".dump")).sort() : [];
      if (list.length === 0) throw new Error(`“${BACKUP_DIR}”里还没有备份，先跑 pnpm db:backup`);
      return join(BACKUP_DIR, list.at(-1));
    })();

const temp = `${conn.database}_restore_check`;
const admin = { ...conn, database: "postgres" };
const psql = (database, sql) => runPg("psql", ["-d", database, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { ...conn, database });

/** 每张业务表的行数（精确 count，不用统计信息估算） */
function countRows(database) {
  const tables = psql(database, "select tablename from pg_tables where schemaname = 'public' order by tablename")
    .split(/\r?\n/)
    .filter(Boolean);
  const sql = tables.map((t) => `select '${t}', count(*) from "${t}"`).join(" union all ");
  return new Map(
    psql(database, sql)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [table, n] = line.split("|");
        return [table, Number(n)];
      }),
  );
}

console.log(`用备份：${file}`);
psql(admin.database, `drop database if exists "${temp}"`);
psql(admin.database, `create database "${temp}"`);
try {
  runPg("pg_restore", ["-d", temp, "--no-owner", "--exit-on-error", file], conn);
  const restored = countRows(temp);
  const live = countRows(conn.database);
  console.log("");
  console.log("表名".padEnd(28), "备份里".padStart(10), "现在库里".padStart(10));
  let tables = 0;
  for (const [table, n] of restored) {
    tables++;
    const now = live.get(table);
    const mark = now === n ? "" : "  ← 备份之后有变动";
    console.log(table.padEnd(30), String(n).padStart(10), String(now ?? "-").padStart(10), mark);
  }
  const total = [...restored.values()].reduce((a, b) => a + b, 0);
  console.log("");
  console.log(`恢复成功：${tables} 张表、${total} 行都读出来了。行数不同的表是备份之后又有了新单据，属正常。`);
} finally {
  psql(admin.database, `drop database if exists "${temp}"`);
  console.log(`临时库 ${temp} 已删除。`);
}
