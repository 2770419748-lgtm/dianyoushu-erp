"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { WecomError } from "@/server/wecom/client";
import { createOrderBindCode, WecomContactError } from "@/server/wecom/contact-service";
import { simulateScanBindCode } from "@/server/wecom/simulator";

// 销售单详情页“加企业微信”卡片的 Server Function：只做"取当前用户 → 调服务层 → 刷新页面"。

export type WecomActionResult = { ok: true; message?: string } | { ok: false; error: string };

async function run(fn: () => Promise<string | void>): Promise<WecomActionResult> {
  try {
    const message = await fn();
    revalidatePath("/sales/[id]", "page");
    return { ok: true, message: message ?? undefined };
  } catch (error) {
    if (error instanceof WecomContactError || error instanceof WecomError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function createBindCodeAction(salesOrderId: number) {
  const user = await requireUser();
  return run(async () => {
    await createOrderBindCode(user, salesOrderId);
  });
}

export async function simulateScanAction(code: string) {
  const user = await requireUser();
  return run(async () => {
    const result = await simulateScanBindCode(user, code);
    return result.status === "PROCESSED" ? `模拟加好友完成：${result.result}` : `事件没处理成：${result.result}`;
  });
}
