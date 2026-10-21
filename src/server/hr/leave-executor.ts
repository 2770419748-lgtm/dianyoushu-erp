import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { lockRow } from "@/server/db-lock";

// 请假审批的执行器（口径第 19 节）：批到最后一级把请假单标成“已批”，驳回、撤回、批了没做成的标成“驳回”“撤回”。
// 单独放一个文件、不引用审批服务：审批服务通过执行器登记表引用它，请假服务再引用审批服务，不会循环引用。

export class LeaveError extends Error {}

type Tx = Prisma.TransactionClient;

export async function approveLeaveTx(tx: Tx, leaveId: number): Promise<{ id: number; no: string | null }> {
  if (!(await lockRow(tx, "leave_requests", leaveId))) throw new LeaveError("请假单不存在");
  const leave = await tx.leaveRequest.findUniqueOrThrow({ where: { id: leaveId } });
  if (leave.status !== "PENDING") throw new LeaveError("这张请假单已经处理过了");
  await tx.leaveRequest.update({ where: { id: leaveId }, data: { status: "APPROVED" } });
  return { id: leaveId, no: null };
}

/** 审批单驳回 → 请假单驳回；撤回、批了没做成（比如发起人停用了）→ 请假单撤回 */
export async function closeLeaveTx(tx: Tx, leaveId: number, status: "REJECTED" | "CANCELLED" | "FAILED") {
  await tx.leaveRequest.updateMany({ where: { id: leaveId, status: "PENDING" }, data: { status: status === "REJECTED" ? "REJECTED" : "CANCELLED" } });
}
