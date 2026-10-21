import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { lockRow } from "@/server/db-lock";

// 报销审批的执行器（口径第 19 节）：批到最后一级把报销单标成“待付款”，驳回的标“驳回”，撤回或批了没做成的标“撤回”。
// 不引用审批服务：审批服务通过执行器登记表引用它，报销服务再引用审批服务，不会循环引用。

export class ExpenseError extends Error {}

type Tx = Prisma.TransactionClient;

export async function approveExpenseTx(tx: Tx, claimId: number): Promise<{ id: number; no: string | null }> {
  if (!(await lockRow(tx, "expense_claims", claimId))) throw new ExpenseError("报销单不存在");
  const claim = await tx.expenseClaim.findUniqueOrThrow({ where: { id: claimId } });
  if (claim.status !== "PENDING") throw new ExpenseError("这张报销单已经处理过了");
  await tx.expenseClaim.update({ where: { id: claimId }, data: { status: "APPROVED" } });
  return { id: claimId, no: claim.claimNo };
}

export async function closeExpenseTx(tx: Tx, claimId: number, status: "REJECTED" | "CANCELLED" | "FAILED") {
  await tx.expenseClaim.updateMany({ where: { id: claimId, status: "PENDING" }, data: { status: status === "REJECTED" ? "REJECTED" : "CANCELLED" } });
}
