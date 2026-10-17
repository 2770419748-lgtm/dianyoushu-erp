// 本机数据库备份：pg_dump 导出一份压缩备份到“备份”文件夹，只留最近 14 份。
// 用法：pnpm db:backup
// 每天自动跑：见 docs/备份与恢复.md 里的“每天自动备份”（Windows 任务计划程序一行命令）。
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_DIR, connection, runPg, stamp } from "./pg-tools.mjs";

const KEEP = 14;

const conn = connection();
mkdirSync(BACKUP_DIR, { recursive: true });
const file = join(BACKUP_DIR, `${conn.database}-${stamp()}.dump`);

// -Fc：自定义格式（压缩、可以挑表恢复）；--no-owner：恢复到别的库或别的用户时不卡在属主上
runPg("pg_dump", ["-d", conn.database, "-Fc", "--no-owner", "-f", file], conn);
const sizeMb = (statSync(file).size / 1024 / 1024).toFixed(1);
console.log(`备份完成：${file}（${sizeMb} MB）`);

// 只留最近 KEEP 份，旧的删掉，免得把盘占满
const old = readdirSync(BACKUP_DIR)
  .filter((f) => f.startsWith(`${conn.database}-`) && f.endsWith(".dump"))
  .sort()
  .reverse()
  .slice(KEEP);
for (const f of old) {
  unlinkSync(join(BACKUP_DIR, f));
  console.log(`清理旧备份：${f}`);
}
