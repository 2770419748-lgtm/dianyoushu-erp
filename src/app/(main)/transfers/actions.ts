"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import * as transfer from "@/server/transfer/transfer-service";
import { ApprovalRequiredError } from "@/server/approval/approval-check";
import { submitForApproval } from "@/server/approval/approval-service";

/** approval：触发了审批规则，这次没做，存成了审批单（口径第 17 节） */
export type TransferActionResult = { ok: true; id?: number } | { ok: false; error: string; approval?: { id: number; requestNo: string } };

async function run(fn: () => Promise<{ id: number } | void>, onApproval?: (error: ApprovalRequiredError) => Promise<TransferActionResult>): Promise<TransferActionResult> {
  try {
    const result = await fn();
    revalidatePath("/transfers");
    revalidatePath("/transfers/[id]", "page");
    revalidatePath("/stock");
    revalidatePath("/stock/ledger");
    return { ok: true, id: result?.id };
  } catch (error) {
    if (error instanceof ApprovalRequiredError && onApproval) {
      revalidatePath("/approvals");
      return onApproval(error);
    }
    if (error instanceof transfer.TransferError) return { ok: false, error: error.message };
    if (error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function createTransferAction(input: transfer.TransferInput) {
  const user = await requireUser();
  return run(
    () => transfer.createTransfer(user, input),
    (error) => submitForApproval(user, error, { action: "TRANSFER", input, details: [] }),
  );
}

export async function shipTransferAction(id: number) {
  const user = await requireUser();
  return run(() => transfer.shipTransfer(user, id));
}

export async function receiveTransferAction(id: number, input: transfer.ReceiveTransferInput) {
  const user = await requireUser();
  return run(() => transfer.receiveTransfer(user, id, input));
}

export async function voidTransferAction(id: number) {
  const user = await requireUser();
  return run(() => transfer.voidTransfer(user, id));
}

/** 新建调拨时按码或商品名搜发出店的在库机器（分页） */
export async function listTransferDevicesAction(storeId: number, q: string, page: number) {
  const user = await requireUser();
  try {
    return await transfer.listDevicesForTransfer(user, storeId, { q, page });
  } catch {
    return { rows: [], total: 0, page: 1, pageSize: transfer.TRANSFER_DEVICE_PAGE_SIZE };
  }
}
