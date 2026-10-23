"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { PermissionError } from "@/server/auth/scope";
import { isUniqueViolation } from "@/server/db-errors";
import { invoiceActions, InvoiceError, saveSeller } from "@/server/invoice/invoice-service";

// 发票的 Server Function：只做"取当前用户 → 调服务层 → 刷新页面"，规则都在服务层（口径第 16 节）。

export type InvoiceActionResult = { ok: true; id?: number; message?: string } | { ok: false; error: string };

async function run(fn: () => Promise<{ id?: number; message?: string } | void>): Promise<InvoiceActionResult> {
  try {
    const result = await fn();
    revalidatePath("/invoices", "layout");
    revalidatePath("/sales", "layout");
    return { ok: true, id: result?.id, message: result?.message };
  } catch (error) {
    if (error instanceof InvoiceError || error instanceof PermissionError) return { ok: false, error: error.message };
    // 两个人同时给同一张单申请开票、同时登记同一个号码：数据库唯一索引兜底
    if (isUniqueViolation(error)) return { ok: false, error: "刚被别人申请或登记过了，刷新看一下" };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function requestInvoiceAction(input: { salesOrderId: number; kind: string; titleType: string; titleName: string; buyerTaxNo?: string; buyerAddressPhone?: string; buyerBankAccount?: string; receiver?: string }) {
  const user = await requireWritableUser();
  return run(async () => {
    const r = await invoiceActions.request(user, input);
    return { id: r.id, message: `已提交开票申请 ${r.requestNo}` };
  });
}

export async function cancelInvoiceAction(id: number, reason: string) {
  const user = await requireWritableUser();
  return run(async () => {
    await invoiceActions.cancel(user, id, reason);
    return { message: "已撤回" };
  });
}

export async function issueInvoiceAction(id: number, invoiceNumber: string) {
  const user = await requireWritableUser();
  return run(async () => {
    const r = await invoiceActions.issue(user, id, { invoiceNumber });
    return { message: `已开具，发票号码 ${r.invoiceNumber}` };
  });
}

export async function redInvoiceAction(id: number, input: { redNumber: string; reason: string }) {
  const user = await requireWritableUser();
  return run(async () => {
    await invoiceActions.red(user, id, input);
    return { message: "已红冲" };
  });
}

export async function markDeliveredAction(id: number) {
  const user = await requireWritableUser();
  return run(async () => {
    await invoiceActions.delivered(user, id);
    return { message: "已确认到店" };
  });
}

export async function saveSellerAction(input: { name: string; taxNo: string; addressPhone: string; bankAccount: string }) {
  const user = await requireWritableUser();
  return run(async () => {
    await saveSeller(user, input);
    return { message: "已保存" };
  });
}
