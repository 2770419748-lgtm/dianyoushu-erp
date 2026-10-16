"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import * as transfer from "@/server/transfer/transfer-service";

export type TransferActionResult = { ok: true; id?: number } | { ok: false; error: string };

async function run(fn: () => Promise<{ id: number } | void>): Promise<TransferActionResult> {
  try {
    const result = await fn();
    revalidatePath("/transfers");
    revalidatePath("/transfers/[id]", "page");
    revalidatePath("/stock");
    revalidatePath("/stock/ledger");
    return { ok: true, id: result?.id };
  } catch (error) {
    if (error instanceof transfer.TransferError) return { ok: false, error: error.message };
    if (error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function createTransferAction(input: transfer.TransferInput) {
  const user = await requireUser();
  return run(() => transfer.createTransfer(user, input));
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
