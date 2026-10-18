import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// 一键重置的第一步：清空所有业务表（保留 Prisma 的迁移记录表），自增 id 归零。
// 第二步由 package.json 的 db:reset 脚本接着跑 prisma/seed.ts 重新生成模拟数据。
// 安全阀：只允许对本机数据库（localhost / 127.0.0.1）执行；以后线上库要重置必须显式设置 ALLOW_DB_RESET=1。

const url = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();

// 真上线（DEMO_MODE=0）的库一律不准重置，不管 ALLOW_DB_RESET 怎么设
if (process.env.DEMO_MODE === "0") {
  console.error("拒绝重置：DEMO_MODE=0 表示这是真实使用的库，清空会丢掉门店的真实数据。");
  process.exit(1);
}

if (!["localhost", "127.0.0.1", "::1"].includes(host) && process.env.ALLOW_DB_RESET !== "1") {
  console.error(`拒绝重置：数据库主机是 "${host || "未知"}"，不是本机。确定要清空请设置 ALLOW_DB_RESET=1 再跑。`);
  process.exit(1);
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) {
    console.log("没有业务表，先跑 pnpm db:migrate");
  } else {
    const list = tables.map((t) => `"${t.tablename}"`).join(", ");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    console.log(`已清空 ${tables.length} 张表（${host}/dianyoushu_erp）`);
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
