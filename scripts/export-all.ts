import "dotenv/config";
import { chmodSync, createWriteStream, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { exportCell } from "@/lib/csv";
import { decryptPii } from "@/server/pii/crypto";
import { assertDataKeys } from "@/server/pii/key-check";

// 全量导出（口径第 21 节）：客户停用或要走的时候，把这家的数据一张表一个 CSV 交给他。
// 用法（服务器上）：docker compose --profile tools run --rm tools pnpm export:all [--out exports/某某通讯-20271231]
// - 一个只读事务里导，各表是同一时刻的数据；
// - 加密存的手机号、身份证号、发票接收人解开成明文（列名去掉 _enc），指纹列（_fp）不导；
// - 密码哈希、二次验证密钥、企业微信令牌缓存、钥匙核对记录、迁移记录不导；门店群机器人地址（带 key，能往群里发消息）只导“已填”
//   （2026-10-23 复查第 69 条）；
// - CSV 带 UTF-8 BOM，Excel 直接打开不乱码；时间是北京时间；12 位以上的纯数字（身份证号、串号）前面加 '，免得 Excel 丢位（第 71 条）；
// - 文件夹 700、文件 600，只有跑脚本的账号能读（第 70 条）。
// 导出的文件夹里是明文个人信息：交接完就删，别留在服务器上，也别进仓库（exports/ 已在 .gitignore 里）。

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SKIP_TABLES = new Set(["_prisma_migrations", "wecom_token_cache"]);
const SKIP_COLUMNS = new Set(["password_hash", "mfa_secret_enc", "mfa_last_step"]);
const SKIP_SETTINGS = new Set(["data_key_check"]);
/** 只导“填没填”的列：门店群机器人地址里带着 key */
const MASKED_COLUMNS = new Map([["wecom_webhook_url", "已填（机器人地址带密钥，不导出）"]]);
const PAGE = 5000;

interface Column {
  name: string;
  type: string; // information_schema 的 data_type
}

function stamp(now: Date): string {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000).toISOString();
  return bj.slice(0, 10).replace(/-/g, "") + "-" + bj.slice(11, 16).replace(":", "");
}

/** 每一列都在库里转成文字：时间换成北京时间，其余照 PostgreSQL 的写法 */
function selectExpr(c: Column): string {
  const q = `"${c.name.replace(/"/g, '""')}"`;
  if (c.type === "timestamp without time zone") return `to_char((${q} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')`;
  if (c.type === "timestamp with time zone") return `to_char(${q} AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')`;
  return `${q}::text`;
}

async function main() {
  process.umask(0o077); // 这里写的都是明文个人信息：新建的文件夹 700、文件 600
  const out = path.resolve(arg("out") ?? path.join("exports", `export-${stamp(new Date())}`));
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} 里已经有文件，换一个 --out`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700); // 文件夹原来就有（空的）时也收紧
  await assertDataKeys(prisma, "全量导出");

  const summary: { table: string; rows: number; decrypted: string[] }[] = [];
  let failed = 0;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const tables = await tx.$queryRaw<{ name: string }[]>(Prisma.sql`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
      for (const { name: table } of tables) {
        if (SKIP_TABLES.has(table)) continue;
        const columns = (
          await tx.$queryRaw<Column[]>(Prisma.sql`
            SELECT column_name AS name, data_type AS type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`)
        ).filter((c) => !SKIP_COLUMNS.has(c.name) && !c.name.endsWith("_fp"));
        const header = columns.map((c) => (c.name.endsWith("_enc") ? c.name.slice(0, -4) : c.name));
        const decrypted = header.filter((_, i) => columns[i].name.endsWith("_enc"));
        const keyColumn = columns.findIndex((c) => c.name === "key");
        // 按主键排序（没有主键的按全部列），分页稳定、看着也顺
        const pk = await tx.$queryRaw<{ name: string }[]>(Prisma.sql`
          SELECT a.attname AS name FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey::int2[])
          WHERE i.indrelid = format('%I.%I', 'public', ${table}::text)::regclass AND i.indisprimary
          ORDER BY array_position(i.indkey::int2[], a.attnum)`);
        const order = pk.length > 0 ? pk.map((p) => `"${p.name.replace(/"/g, '""')}"`).join(", ") : columns.map((_, i) => `${i + 1}`).join(", ");
        const file = createWriteStream(path.join(out, `${table}.csv`), { encoding: "utf8" });
        file.write("﻿" + header.map(exportCell).join(",") + "\r\n");
        let rows = 0;
        const select = columns.map((c, i) => `${selectExpr(c)} AS c${i}`).join(", ");
        for (let offset = 0; ; offset += PAGE) {
          const page = await tx.$queryRawUnsafe<Record<string, string | null>[]>(`SELECT ${select} FROM "${table}" ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`);
          for (const r of page) {
            const values = columns.map((c, i) => {
              const v = r[`c${i}`];
              if (v !== null && MASKED_COLUMNS.has(c.name)) return MASKED_COLUMNS.get(c.name)!;
              if (v === null || !c.name.endsWith("_enc")) return v;
              try {
                return decryptPii(v);
              } catch {
                failed += 1;
                return "（解不开）";
              }
            });
            if (table === "system_settings" && keyColumn >= 0 && SKIP_SETTINGS.has(values[keyColumn] ?? "")) continue;
            if (!file.write(values.map(exportCell).join(",") + "\r\n")) await once(file, "drain");
            rows += 1;
          }
          if (page.length < PAGE) break;
        }
        file.end();
        await once(file, "finish");
        summary.push({ table, rows, decrypted });
      }
    },
    { timeout: 30 * 60 * 1000, maxWait: 30 * 1000 },
  );

  writeFileSync(
    path.join(out, "清单.csv"),
    "﻿表,行数,解开的个人信息列\r\n" + summary.map((s) => [s.table, String(s.rows), s.decrypted.join(" ")].map(exportCell).join(",")).join("\r\n") + "\r\n",
  );
  writeFileSync(
    path.join(out, "说明.txt"),
    [
      "店有数 ERP 全量导出",
      `导出时间（北京时间）：${stamp(new Date())}`,
      "一张表一个 CSV，UTF-8 带 BOM，Excel 直接打开；各表是同一时刻的数据。",
      "时间列是北京时间；金额列单位是分（除以 100 是元）。",
      "手机号、身份证号、发票接收人已解开成明文（列名去掉 _enc）。密码、二次验证密钥、企业微信令牌不在里面；门店群机器人地址只写“已填”（地址里带密钥）。",
      "以 = + @ 开头（或 - 开头但不是数字）的格子、12 位以上的纯数字（身份证号、串号）前面加了一个英文单引号 '：防止 Excel 当公式算、把长号码改成科学计数法丢位。原值是去掉这个 ' 的部分。",
      "这里是明文个人信息，请妥善保管，用完删除。",
      "",
    ].join("\r\n"),
  );
  const total = summary.reduce((s, t) => s + t.rows, 0);
  console.log(`导出完成：${summary.length} 张表、${total} 行，在 ${out}`);
  if (failed > 0) {
    console.error(`有 ${failed} 个个人信息解不开（写成了“（解不开）”），先查钥匙再重导`);
    process.exitCode = 1;
  }
  console.log("这个文件夹里是明文个人信息：交接完就删，别留在服务器上。");
}

main()
  .catch((error) => {
    console.error(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
