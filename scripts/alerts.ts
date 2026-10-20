import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import { runAlerts } from "@/server/alerts/alert-service";

// pnpm alerts:run：智能提醒（口径第 18 节），服务器定时任务每天早上 9 点、晚上 9 点各跑一次
// （docker compose run --rm tools pnpm alerts:run，见 docs/部署.md）。同一天再跑会更新今天的提醒，内容没变不重复推群。
// 脚本里要用服务层（带 server-only 标记），所以 package.json 里用 tsx --conditions=react-server 跑。

async function main() {
  const report = await runAlerts();
  await writeAudit({ userId: null, action: "alerts.run", detail: { scope: "all", ...report } as never });
  console.log(`智能提醒：命中 ${report.items} 条，今日待办 ${report.digests} 份（内容有变 ${report.changed} 份），新消息 ${report.notified} 条，推门店群 ${JSON.stringify(report.pushed)}，写法 ${JSON.stringify(report.sources)}`);
  if (report.pushed.FAILED > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
