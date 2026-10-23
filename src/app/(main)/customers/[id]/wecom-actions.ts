"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { WecomError } from "@/server/wecom/client";
import { transferOnJob, WecomTransferError } from "@/server/wecom/transfer-service";
import { unbindCustomerWecom, WecomContactError } from "@/server/wecom/contact-service";

// 客户详情“转接跟进人”的 Server Function（口径第 12 节第三步）：取当前用户 → 调服务层 → 刷新页面。

export async function unbindWecomAction(customerId: number, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireWritableUser();
  try {
    await unbindCustomerWecom(user, customerId, reason);
    revalidatePath("/customers/[id]", "page");
    return { ok: true };
  } catch (error) {
    if (error instanceof WecomContactError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function transferFollowAction(followId: number, toUserId: number): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const user = await requireWritableUser();
  try {
    const result = await transferOnJob(user, { followId, toUserId });
    revalidatePath("/customers/[id]", "page");
    return { ok: true, to: result.to };
  } catch (error) {
    if (error instanceof WecomTransferError || error instanceof WecomError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}
