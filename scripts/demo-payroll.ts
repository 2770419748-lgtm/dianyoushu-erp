import "dotenv/config";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { generatePayroll, publishPayroll, setAdjustment } from "@/server/hr/payroll-service";

// 演示数据的最后一步（pnpm db:reset 里跑）：用真的服务层给上个月生成工资条、加两笔奖惩、发布，
// 这样“工资条”页和员工自己的工资条都有东西看，门店收支也有上个月的人工成本。这个月的留给现场演示“生成工资条”。
// 服务层带 server-only 标记，所以 package.json 里用 tsx --conditions=react-server 跑。

async function main() {
  const hq = await prisma.user.findFirst({ where: { username: "hq" }, include: { store: true, region: true } });
  if (!hq) throw new Error("没有演示总部账号 hq，先跑种子数据");
  const user = hq as unknown as CurrentUser;
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const month = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const run = await generatePayroll(user, month);
  // 两笔奖惩：演示店员拿个服务之星奖，另一个店员迟到太多扣一点
  const staff = await prisma.user.findFirst({ where: { username: "staff" } });
  const slips = await prisma.payrollSlip.findMany({ where: { runId: run.runId }, orderBy: { absentDays: "desc" }, take: 2, select: { id: true, userId: true } });
  const star = staff ? await prisma.payrollSlip.findFirst({ where: { runId: run.runId, userId: staff.id }, select: { id: true } }) : null;
  if (star) await setAdjustment(user, star.id, { adjustmentFen: 20000, note: "服务之星奖（顾客好评 3 条）" });
  const late = slips.find((s) => s.id !== star?.id);
  if (late) await setAdjustment(user, late.id, { adjustmentFen: -5000, note: "当月迟到多，按店规扣罚" });
  await publishPayroll(user, run.runId);
  const done = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.runId } });
  console.log(`工资条：${month} ${done.slipCount} 张，应发合计 ${(done.grossFen / 100).toFixed(2)} 元，已发布`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
