"use server";

import { revalidatePath } from "next/cache";
import { formatFen } from "@/lib/format";
import { requireWritableUser } from "@/server/license/license-service";
import { generatePayroll, PayrollError, publishPayroll, savePlan, setAdjustment, voidPayroll } from "@/server/hr/payroll-service";

// 提成和工资条（口径第 19 节）：都是总部的操作；规则在服务层。

export type PayrollActionResult = { ok: true; message: string } | { ok: false; error: string };

async function run(fn: () => Promise<string>): Promise<PayrollActionResult> {
  try {
    const message = await fn();
    revalidatePath("/hr", "layout");
    return { ok: true, message };
  } catch (error) {
    if (error instanceof PayrollError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function generatePayrollAction(month: string) {
  const user = await requireWritableUser();
  return run(async () => {
    const r = await generatePayroll(user, month);
    const extra = [
      r.carried ? `带上了上一份作废工资里的 ${r.carried} 笔奖惩` : null,
      r.stale.length ? `${r.stale.slice(0, 5).join("、")}${r.stale.length > 5 ? " 等" : ""}账号在用、离职日期却已经过了（底薪按离职日期折算，离职日期在这个月以前的没生成工资条），到员工档案核对` : null,
    ].filter(Boolean);
    return `已生成 ${r.slipCount} 张工资条，应发合计 ${formatFen(r.grossFen)} 元（草稿，核对完再发布）${extra.length ? `；${extra.join("；")}` : ""}`;
  });
}

export async function adjustAction(slipId: number, adjustmentFen: number, note: string) {
  const user = await requireWritableUser();
  return run(async () => {
    await setAdjustment(user, slipId, { adjustmentFen, note });
    return "已改奖惩";
  });
}

export async function publishPayrollAction(runId: number) {
  const user = await requireWritableUser();
  return run(async () => {
    const r = await publishPayroll(user, runId);
    const changed = r.changedFen !== 0 || r.slipsChanged ? `；发布前按最新数据重算了一遍（奖惩照留），现在 ${r.slipCount} 张、应发合计 ${formatFen(r.grossFen)} 元，比草稿${r.changedFen >= 0 ? "多" : "少"} ${formatFen(Math.abs(r.changedFen))} 元` : "";
    return `已发布，员工能在“工资条”里看自己的了${changed}`;
  });
}

export async function voidPayrollAction(runId: number, reason: string) {
  const user = await requireWritableUser();
  return run(async () => {
    await voidPayroll(user, runId, reason);
    return "已整月作废，可以重新生成";
  });
}

export async function savePlanAction(input: { id?: number; name: string; salesRateBp: number; perDeviceFen: number; perServiceFen: number; isActive: boolean; note?: string }) {
  const user = await requireWritableUser();
  return run(async () => {
    await savePlan(user, input);
    return "提成方案已保存，下次生成工资条按新方案算";
  });
}
