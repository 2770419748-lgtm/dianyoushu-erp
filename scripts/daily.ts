import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { assertDataKeys } from "@/server/pii/key-check";
import { isWritable, licenseState } from "@/lib/license";
import { bjDateKey } from "@/lib/attendance";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { getLicense } from "@/server/settings/settings-service";
import { writeAudit } from "@/server/audit";
import { scanEntitlementReminders } from "@/server/entitlement/entitlement-service";
import { getWecomClient } from "@/server/wecom/client";
import { replayFailedEvents } from "@/server/wecom/callback-service";
import { wecomMode } from "@/server/wecom/config";
import { cleanupExpiredBindCodes } from "@/server/wecom/contact-service";
import { cleanupKfMessages } from "@/server/wecom/kf-service";
import { processTransfers } from "@/server/wecom/transfer-service";

// pnpm daily：每天跑一次（建议早上 9 点）。服务器上用 tools 服务跑：docker compose run --rm tools pnpm daily（见 docs/部署.md）。
// 1. 生成碎屏险、延保的到期提醒（口径第 12 节：剩 8～30 天、剩 0～7 天两档，每档只生成一次，漏跑一天也不会漏人）
// 2. 企业微信：处理失败的回调事件重放一遍；过期没扫的开单二维码，删掉企业微信那边的活码配置；微信客服消息只留 180 天；
//    客户继承：离职员工删了就提交、已提交的查结果回写
// 每一步单独 try：前一步出错不影响后面；有出错的退出码 1，计划任务能据此告警。
// 过了宽限期只读以后（口径第 21 节）：不再生成到期提醒；企业微信的清理（消息只留 180 天、过期二维码）、补处理回调、离职继承照跑
// （只读以后总部还能停用离职员工，他的客户要能交接出去）。
// 脚本里要用服务层（带 server-only 标记），所以 package.json 里用 tsx --conditions=react-server 跑。

async function main() {
  await assertDataKeys(prisma, "每日任务"); // 钥匙对不上就停（口径第 20 节），不然生成的提醒里客户对不上
  const report: Record<string, unknown> = {};
  let failed = false;
  const readonly = !isWritable(licenseState(await getLicense(), bjDateKey(new Date()), DEMO_MODE));

  if (readonly) report.reminders = "服务已到期（只读），不生成到期提醒";
  else {
    try {
      report.reminders = await scanEntitlementReminders();
    } catch (error) {
      failed = true;
      report.reminders = `出错：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const mode = wecomMode();
  report.wecomMode = mode;
  if (mode !== "off") {
    try {
      report.kfCleanup = await cleanupKfMessages();
    } catch (error) {
      failed = true;
      report.kfCleanup = `出错：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (mode === "real") {
    try {
      const client = getWecomClient();
      report.replay = await replayFailedEvents({ client });
      const cleanup = await cleanupExpiredBindCodes({ client });
      report.cleanup = cleanup;
      if (cleanup.failed.length > 0) failed = true;
      const transfers = await processTransfers({ client });
      report.transfers = transfers;
      if (transfers.errors.length > 0) failed = true;
    } catch (error) {
      failed = true;
      report.wecom = `出错：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  await writeAudit({ userId: null, action: "daily.run", detail: report as never });
  console.log(`每日任务${failed ? "（有出错）" : ""}：${JSON.stringify(report)}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
