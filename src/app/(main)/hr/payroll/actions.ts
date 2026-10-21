"use server";

import { revalidatePath } from "next/cache";
import { formatFen } from "@/lib/format";
import { requireUser } from "@/server/auth/current-user";
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
  const user = await requireUser();
  return run(async () => {
    const r = await generatePayroll(user, month);
    return `已生成 ${r.slipCount} 张工资条，应发合计 ${formatFen(r.grossFen)} 元（草稿，核对完再发布）`;
  });
}

export async function adjustAction(slipId: number, adjustmentFen: number, note: string) {
  const user = await requireUser();
  return run(async () => {
    await setAdjustment(user, slipId, { adjustmentFen, note });
    return "已改奖惩";
  });
}

export async function publishPayrollAction(runId: number) {
  const user = await requireUser();
  return run(async () => {
    await publishPayroll(user, runId);
    return "已发布，员工能在“工资条”里看自己的了";
  });
}

export async function voidPayrollAction(runId: number, reason: string) {
  const user = await requireUser();
  return run(async () => {
    await voidPayroll(user, runId, reason);
    return "已整月作废，可以重新生成";
  });
}

export async function savePlanAction(input: { id?: number; name: string; salesRateBp: number; perDeviceFen: number; perServiceFen: number; isActive: boolean; note?: string }) {
  const user = await requireUser();
  return run(async () => {
    await savePlan(user, input);
    return "提成方案已保存，下次生成工资条按新方案算";
  });
}
