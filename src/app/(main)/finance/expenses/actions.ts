"use server";

import { revalidatePath } from "next/cache";
import { APPROVER_ROLE_LABELS } from "@/lib/approval";
import type { ExpenseCategoryKey, ExpensePayMethodKey } from "@/lib/expense";
import { requireUser } from "@/server/auth/current-user";
import { cancelExpense, ExpenseError, markExpensePaid, submitExpense } from "@/server/finance/expense-service";

// 费用报销（口径第 19 节）：提交、撤回自己的；总部登记付款。审批在“审批”里批。

export type ExpenseActionResult = { ok: true; message: string } | { ok: false; error: string };

async function run(fn: () => Promise<string>): Promise<ExpenseActionResult> {
  try {
    const message = await fn();
    revalidatePath("/finance", "layout");
    revalidatePath("/approvals", "layout");
    return { ok: true, message };
  } catch (error) {
    if (error instanceof ExpenseError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function submitExpenseAction(input: { category: ExpenseCategoryKey; amountFen: number; occurredOn: string; description: string; storeId?: number | null }) {
  const user = await requireUser();
  return run(async () => {
    const r = await submitExpense(user, input);
    return `已提交报销单 ${r.claimNo}，审批单 ${r.requestNo}：${r.chain.map((c) => APPROVER_ROLE_LABELS[c]).join("批完")}批`;
  });
}

export async function cancelExpenseAction(id: number) {
  const user = await requireUser();
  return run(async () => {
    await cancelExpense(user, id);
    return "已撤回";
  });
}

export async function payExpenseAction(id: number, input: { payMethod: ExpensePayMethodKey; paidOn: string; note: string }) {
  const user = await requireUser();
  return run(async () => {
    await markExpensePaid(user, id, input);
    return "已登记付款";
  });
}
