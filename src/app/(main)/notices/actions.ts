"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { NoticeError, publishNotice, withdrawNotice } from "@/server/notice/notice-service";

// 公告的 Server Function：发布、撤下。

export type NoticeActionResult = { ok: true; message: string; id?: number } | { ok: false; error: string };

export async function publishNoticeAction(input: { title: string; body: string; scope?: string; regionId?: number; storeId?: number }): Promise<NoticeActionResult> {
  const user = await requireWritableUser();
  try {
    const r = await publishNotice(user, input);
    revalidatePath("/notices");
    return { ok: true, message: `发出去了，发给 ${r.recipients} 人`, id: r.id };
  } catch (error) {
    if (error instanceof NoticeError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "发布失败，请稍后再试" };
  }
}

export async function withdrawNoticeAction(id: number): Promise<NoticeActionResult> {
  const user = await requireWritableUser();
  try {
    await withdrawNotice(user, id);
    revalidatePath("/notices");
    return { ok: true, message: "撤下了" };
  } catch (error) {
    if (error instanceof NoticeError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}
