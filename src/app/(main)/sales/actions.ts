"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import * as sales from "@/server/sales/sales-service";

export type SalesActionResult = { ok: true; id?: number; orderNo?: string } | { ok: false; error: string };

async function run(fn: () => Promise<{ id: number; orderNo: string } | void>): Promise<SalesActionResult> {
  try {
    const result = await fn();
    revalidatePath("/sales");
    revalidatePath("/sales/[id]", "page");
    revalidatePath("/stock");
    revalidatePath("/stock/ledger");
    return { ok: true, id: result?.id, orderNo: result?.orderNo };
  } catch (error) {
    if (error instanceof sales.SalesError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function createSalesOrderAction(input: sales.SalesOrderInput) {
  const user = await requireUser();
  return run(() => sales.createSalesOrder(user, input));
}

export async function voidSalesOrderAction(id: number, reason: string) {
  const user = await requireUser();
  return run(() => sales.voidSalesOrder(user, id, reason));
}

/** 开单页搜本店可卖的机器 */
export async function searchSellableDevicesAction(storeId: number, q: string) {
  const user = await requireUser();
  try {
    return await sales.searchSellableDevices(user, storeId, q);
  } catch {
    return [];
  }
}
