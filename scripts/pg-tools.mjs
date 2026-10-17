// 备份 / 恢复脚本共用的小工具：读 .env 里的连接串、找 PostgreSQL 自带的命令行工具。
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** 备份放在仓库外面（默认是代码目录旁边的“备份”文件夹），永远不进 Git */
export const BACKUP_DIR = process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : resolve(PROJECT_ROOT, "..", "备份");

/** 把 DATABASE_URL 拆成 pg_dump 认识的参数；密码走环境变量 PGPASSWORD，不出现在命令行里 */
export function connection() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("没读到 DATABASE_URL：确认 .env 存在");
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

/** 找 pg_dump / pg_restore / psql：先看 PATH，再看 Windows 默认安装位置 */
export function pgTool(name) {
  if (spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) return name;
  for (const version of ["18", "17", "16"]) {
    const path = join("C:\\Program Files\\PostgreSQL", version, "bin", `${name}.exe`);
    if (existsSync(path)) return path;
  }
  throw new Error(`没找到 ${name}：把 PostgreSQL 的 bin 目录加进 PATH`);
}

/** 运行一个 PostgreSQL 工具，失败就抛错；返回标准输出 */
export function runPg(name, args, conn) {
  const result = spawnSync(pgTool(name), ["-h", conn.host, "-p", conn.port, "-U", conn.user, ...args], {
    env: { ...process.env, PGPASSWORD: conn.password },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${name} 失败：${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout;
}

/** 北京时间的 20261016-213000，用在文件名里 */
export function stamp(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}
