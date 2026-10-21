"use server";

import { revalidatePath } from "next/cache";
import { APPROVER_ROLE_LABELS } from "@/lib/approval";
import type { LeaveKindKey } from "@/lib/attendance";
import { requireUser } from "@/server/auth/current-user";
import { cancelLeave, LeaveError, submitLeave } from "@/server/hr/leave-service";

// 请假（口径第 19 节）：员工自己提交、撤回；审批在“审批”里批。

export type LeaveActionResult = { ok: true; message: string } | { ok: false; error: string };

async function run(fn: () => Promise<string>): Promise<LeaveActionResult> {
  try {
    const message = await fn();
    revalidatePath("/hr/leaves");
    revalidatePath("/approvals", "layout");
    return { ok: true, message };
  } catch (error) {
    if (error instanceof LeaveError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "提交失败，请稍后再试" };
  }
}

export async function submitLeaveAction(input: { kind: LeaveKindKey; startDate: string; endDate: string; reason: string }) {
  const user = await requireUser();
  return run(async () => {
    const r = await submitLeave(user, input);
    if (r.autoApproved) return `已登记（审批单 ${r.requestNo}）：总部本人的请假不用批，已经生效`;
    return `已提交审批单 ${r.requestNo}：${r.chain.map((c) => APPROVER_ROLE_LABELS[c]).join("批完")}批`;
  });
}

export async function cancelLeaveAction(id: number) {
  const user = await requireUser();
  return run(async () => {
    await cancelLeave(user, id);
    return "已撤回";
  });
}
