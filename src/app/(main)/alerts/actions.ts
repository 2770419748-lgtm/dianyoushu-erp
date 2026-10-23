"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { AlertError, runAlertsNow } from "@/server/alerts/alert-service";

// 智能提醒页“立即生成”：店长只生成本店，总部全部。
export async function runAlertsAction(): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const user = await requireWritableUser();
  try {
    const r = await runAlertsNow(user);
    revalidatePath("/alerts");
    revalidatePath("/", "layout");
    return { ok: true, message: `生成好了：命中 ${r.items} 条，今日待办 ${r.digests} 份` };
  } catch (error) {
    if (error instanceof AlertError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "生成失败，请稍后再试" };
  }
}
