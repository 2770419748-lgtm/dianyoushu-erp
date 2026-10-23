"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { WecomError } from "@/server/wecom/client";
import { WecomContactError } from "@/server/wecom/contact-service";
import { simulateKfMessage } from "@/server/wecom/simulator";

// 微信客服演示页（总部）的 Server Function：模拟客户发消息、接待人员回复、结束人工接待。

export type KfActionResult = { ok: true; sessionId: number } | { ok: false; error: string };

export async function simulateKfAction(input: { externalUserid?: string; persona?: "bound" | "anon"; text?: string; asServicer?: boolean; endSession?: boolean }): Promise<KfActionResult> {
  const user = await requireWritableUser();
  try {
    const result = await simulateKfMessage(user, input);
    revalidatePath("/wecom/kf");
    return { ok: true, sessionId: result.sessionId };
  } catch (error) {
    if (error instanceof WecomContactError || error instanceof WecomError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}
