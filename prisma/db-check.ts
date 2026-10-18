import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { describeIntegrity, integrityOk, runIntegrityChecks } from "./integrity-checks";

// pnpm db:check：对一遍账（规则见 integrity-checks.ts）。全对退出码 0；有对不上的退出码 1，方便定时任务据此告警。
// 服务器上每天跑：docker compose run --rm tools pnpm db:check（见 docs/部署.md 上线前检查清单）。

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
  try {
    const result = await runIntegrityChecks(prisma);
    const line = `对账自检：${describeIntegrity(result)}`;
    if (integrityOk(result)) {
      console.log(line);
    } else {
      console.error(`${line} 有对不上的，请马上查最近的单据和流水。`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
