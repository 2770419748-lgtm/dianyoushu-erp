"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { EntitlementError, markReminderContacted, runReminderScan } from "@/server/entitlement/entitlement-service";

// 到期名单页的 Server Function：只做"取当前用户 → 调服务层 → 刷新页面"，规则都在服务层。

export type EntitlementActionResult = { ok: true; message?: string } | { ok: false; error: string };

async function run(fn: () => Promise<string | void>): Promise<EntitlementActionResult> {
  try {
    const message = await fn();
    revalidatePath("/entitlements");
    return { ok: true, message: message ?? undefined };
  } catch (error) {
    if (error instanceof EntitlementError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function runReminderScanAction() {
  const user = await requireWritableUser();
  return run(async () => {
    const created = await runReminderScan(user);
    const total = created.T30 + created.T7;
    return total === 0 ? "没有新的提醒：在区间里的都已经生成过了" : `新生成 ${total} 条提醒（剩 8～30 天 ${created.T30} 条，剩 0～7 天 ${created.T7} 条）`;
  });
}

export async function markContactedAction(reminderId: number, note: string) {
  const user = await requireWritableUser();
  return run(() => markReminderContacted(user, reminderId, note));
}
