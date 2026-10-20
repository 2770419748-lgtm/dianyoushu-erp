"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import * as sales from "@/server/sales/sales-service";
import { createReturn, ReturnError, type ReturnInput } from "@/server/sales/return-service";
import { lookupForSale, type SaleLookup } from "@/server/sales/lookup";
import { previewSubsidy, SubsidyError } from "@/server/subsidy/subsidy-service";

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
/** 开单页“核对国补”：算补哪台、补多少，核验资格码；不写库 */
export async function previewSubsidyAction(input: Parameters<typeof previewSubsidy>[1]): Promise<{ ok: true; preview: Awaited<ReturnType<typeof previewSubsidy>> } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    return { ok: true, preview: await previewSubsidy(user, input) };
  } catch (error) {
    if (error instanceof SubsidyError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "核对国补失败，请稍后再试" };
  }
}

export async function searchSellableDevicesAction(storeId: number, q: string) {
  const user = await requireUser();
  try {
    return await sales.searchSellableDevices(user, storeId, q);
  } catch {
    return [];
  }
}

/** 扫码 / 输码加商品：先认机器串号，再认配件条码 */
export async function lookupForSaleAction(storeId: number, code: string): Promise<SaleLookup> {
  const user = await requireUser();
  try {
    return await lookupForSale(user, storeId, code);
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "error", message: error.message };
    console.error(error);
    return { kind: "error", message: "查找失败，请稍后再试" };
  }
}

/** 退货：选原单明细退回、按原收款方式退款 */
export async function createReturnAction(input: ReturnInput): Promise<SalesActionResult> {
  const user = await requireUser();
  try {
    const result = await createReturn(user, input);
    revalidatePath("/sales");
    revalidatePath("/sales/[id]", "page");
    revalidatePath("/stock");
    revalidatePath("/stock/ledger");
    revalidatePath("/trade-ins/stock");
    return { ok: true, id: result.id, orderNo: result.orderNo };
  } catch (error) {
    if (error instanceof ReturnError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}
