"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import * as purchase from "@/server/purchase/purchase-service";

export type PurchaseActionResult = { ok: true; id?: number } | { ok: false; error: string };

async function run(fn: () => Promise<{ id: number } | void>): Promise<PurchaseActionResult> {
  try {
    const result = await fn();
    revalidatePath("/purchase");
    revalidatePath("/purchase/[id]", "page");
    revalidatePath("/stock");
    revalidatePath("/stock/ledger");
    return { ok: true, id: result?.id };
  } catch (error) {
    if (error instanceof purchase.PurchaseError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function createPurchaseOrderAction(input: purchase.PurchaseOrderInput) {
  const user = await requireUser();
  return run(() => purchase.createPurchaseOrder(user, input));
}

export async function updatePurchaseOrderAction(id: number, input: purchase.PurchaseOrderInput) {
  const user = await requireUser();
  return run(() => purchase.updatePurchaseOrder(user, id, input));
}

export async function submitPurchaseOrderAction(id: number) {
  const user = await requireUser();
  return run(() => purchase.submitPurchaseOrder(user, id));
}

export async function voidPurchaseOrderAction(id: number, reason: string) {
  const user = await requireUser();
  return run(() => purchase.voidPurchaseOrder(user, id, reason));
}

export async function receiveGoodsAction(input: purchase.ReceiveGoodsInput) {
  const user = await requireUser();
  return run(() => purchase.receiveGoods(user, input));
}
