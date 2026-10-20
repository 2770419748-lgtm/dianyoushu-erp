"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { WecomError } from "@/server/wecom/client";
import { createResignedTransfers, processTransfersNow, WecomTransferError } from "@/server/wecom/transfer-service";

// 客户继承页（店长、总部）的 Server Function：查进度、给离职员工的客户安排接手人。

export type TransferActionResult = { ok: true; message: string } | { ok: false; error: string };

async function run(fn: () => Promise<string>): Promise<TransferActionResult> {
  try {
    const message = await fn();
    revalidatePath("/wecom/transfers");
    return { ok: true, message };
  } catch (error) {
    if (error instanceof WecomTransferError || error instanceof WecomError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function processTransfersAction() {
  const user = await requireUser();
  return run(async () => {
    const r = await processTransfersNow(user);
    const parts = [`提交 ${r.submitted} 个`, `接替完毕 ${r.done} 个`, `客户拒绝 ${r.refused} 个`, `失败 ${r.failed} 个`, `还在等 ${r.pending + r.waitingDelete} 个`];
    return `查完了：${parts.join("，")}${r.errors.length > 0 ? `；出错：${r.errors.join("；")}` : ""}`;
  });
}

export async function assignResignedAction(fromUserId: number, toUserId: number) {
  const user = await requireUser();
  return run(async () => {
    const r = await createResignedTransfers(user, { fromUserId, toUserId });
    return `${r.from}的 ${r.count} 个客户交给${r.to}：企业微信后台删掉${r.from}之后提交`;
  });
}
