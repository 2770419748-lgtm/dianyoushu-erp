import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { assertDataKeys } from "@/server/pii/key-check";
import { isWritable, licenseState } from "@/lib/license";
import { bjDateKey } from "@/lib/attendance";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { getLicense } from "@/server/settings/settings-service";
import { writeAudit } from "@/server/audit";
import { runAlerts } from "@/server/alerts/alert-service";

// pnpm alerts:run：智能提醒（口径第 18 节），服务器定时任务每天早上 9 点、晚上 9 点各跑一次
// （docker compose run --rm tools pnpm alerts:run，见 docs/部署.md）。同一天再跑会更新今天的提醒，内容没变不重复推群。
// 脚本里要用服务层（带 server-only 标记），所以 package.json 里用 tsx --conditions=react-server 跑。
// 过了宽限期只读以后（口径第 21 节）不跑：不生成今日待办、不推门店群、不调大模型。

async function main() {
  await assertDataKeys(prisma, "智能提醒"); // 钥匙对不上就停（口径第 20 节）
  if (!isWritable(licenseState(await getLicense(), bjDateKey(new Date()), DEMO_MODE))) {
    console.log("智能提醒：服务已到期（只读），这次不跑");
    return;
  }
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
