import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { signSessionToken } from "../src/server/auth/token";

// 简单压测：用 hq 和 manager 的登录 cookie，N 路并发、每路请求 M 次，统计每个页面的 p50 / p95 / 最大耗时和错误数。
//
// 用法（在跑服务的那台机器上，和服务用同一份 .env）：
//   1. 先起生产构建：pnpm build && pnpm start（或服务器上 docker compose up），库里要有演示数据（pnpm db:reset）
//   2. pnpm load-test                 默认 10 路并发 × 每路 10 次
//      pnpm load-test 30 10           30 路并发 × 每路 10 次
//      LOAD_BASE=http://127.0.0.1:3000 pnpm load-test   换目标地址
// 登录 cookie 是直接用 .env 里的 SESSION_SECRET 签出来的（和登录时签的一样），所以不用开浏览器。
// 参考结果（2026-10-18 自检，云端 4 核）：10 并发看板 p50 约 1 秒，30 并发约 2.7 秒，0 错误；单进程 Node 是瓶颈。

const BASE = process.env.LOAD_BASE ?? "http://localhost:3000";
const concurrency = Number(process.argv[2] ?? 10);
const rounds = Number(process.argv[3] ?? 10);

async function cookieFor(prisma: PrismaClient, username: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { username }, select: { id: true, sessionVersion: true } });
  const token = await signSessionToken({ userId: user.id, sv: user.sessionVersion }, new Date(Date.now() + 3600_000));
  return `erp_session=${token}`;
}

async function bench(name: string, path: string, cookie: string) {
  const times: number[] = [];
  let errors = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let i = 0; i < rounds; i++) {
        const t = Date.now();
        try {
          const r = await fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
          await r.arrayBuffer();
          if (r.status !== 200) errors++;
        } catch {
          errors++;
        }
        times.push(Date.now() - t);
      }
    }),
  );
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  console.log(`${name.padEnd(24)} ${`${concurrency}x${rounds}`.padEnd(7)} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${times.at(-1)}ms err=${errors}`);
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
  try {
    const hq = await cookieFor(prisma, "hq");
    const mgr = await cookieFor(prisma, "manager");
    const code = (await prisma.device.findFirst({ where: { status: "IN_STOCK" }, select: { code: true } }))?.code ?? "860010000000000";
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86400_000);
    const d = (x: Date) => x.toISOString().slice(0, 10);
    const pages: [string, string, string][] = [
      ["hq 看板（全部门店）", "/dashboard", hq],
      ["hq 库存列表", "/stock", hq],
      ["hq 销售单列表", "/sales", hq],
      ["hq 库存流水", "/stock/ledger", hq],
      ["hq 收银日报 3 个月", `/reports/cashier?from=${d(from)}&to=${d(to)}`, hq],
      ["hq 日报导出 CSV", `/api/reports/cashier?from=${d(from)}&to=${d(to)}`, hq],
      ["店长 看板", "/dashboard", mgr],
      ["店长 日结", "/daily-close", mgr],
      ["店长 开单页", "/sales/new", mgr],
      ["店长 手机查库存", `/m/stock?q=${code}`, mgr],
      ["店长 客户搜尾号", "/customers?q=8900", mgr],
    ];
    console.log(`目标 ${BASE}，${concurrency} 路并发 × 每路 ${rounds} 次`);
    for (const [name, path, cookie] of pages) await bench(name, path, cookie);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
