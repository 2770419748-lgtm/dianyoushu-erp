"use server";

import { revalidatePath } from "next/cache";
import { APPROVER_ROLE_LABELS } from "@/lib/approval";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { ApprovalError, approveRequest, cancelRequest, rejectRequest, saveRule } from "@/server/approval/approval-service";

// 审批的 Server Function：只做"取当前用户 → 调服务层 → 刷新页面"，规则都在服务层（口径第 17 节）。

export type ApprovalActionResult = { ok: true; message?: string; href?: string } | { ok: false; error: string };

function refresh() {
  revalidatePath("/approvals", "layout");
  revalidatePath("/sales", "layout");
  revalidatePath("/transfers", "layout");
  revalidatePath("/stocktakes", "layout");
  revalidatePath("/stock", "layout");
  revalidatePath("/hr", "layout");
  revalidatePath("/finance", "layout");
}

async function run(fn: () => Promise<{ message?: string; href?: string } | void>): Promise<ApprovalActionResult> {
  try {
    const result = await fn();
    refresh();
    return { ok: true, message: result?.message, href: result?.href };
  } catch (error) {
    if (error instanceof ApprovalError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function approveAction(id: number, note: string) {
  const user = await requireUser();
  return run(async () => {
    const r = await approveRequest(user, id, note);
    if (r.executed) return { message: `已通过，${r.resultNo ? `做出来的单号 ${r.resultNo}` : "已经生效"}` };
    if ("forwardedTo" in r) return { message: `这一级已同意，转给${APPROVER_ROLE_LABELS[r.forwardedTo]}再批` };
    return { message: `已通过，但这件事现在做不成了：${r.error}` };
  });
}

export async function rejectAction(id: number, note: string) {
  const user = await requireUser();
  return run(async () => {
    await rejectRequest(user, id, note);
    return { message: "已驳回" };
  });
}

export async function cancelApprovalAction(id: number) {
  const user = await requireUser();
  return run(async () => {
    await cancelRequest(user, id);
    return { message: "已撤回" };
  });
}

export async function saveRuleAction(input: { kind: string; enabled: boolean; thresholdFen: number | null; thresholdBp: number | null; approverRole: string; note?: string }) {
  const user = await requireUser();
  return run(async () => {
    await saveRule(user, input);
    return { message: "已保存，以后的操作按新规则判断" };
  });
}
