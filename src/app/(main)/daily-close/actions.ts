"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import * as dc from "@/server/dailyclose/daily-close-service";

export type DailyCloseActionResult = { ok: true; message?: string } | { ok: false; error: string };

function refresh() {
  revalidatePath("/daily-close");
  revalidatePath("/reports/cashier");
  revalidatePath("/sales");
  revalidatePath("/sales/[id]", "page");
}

async function run(fn: () => Promise<string | void>): Promise<DailyCloseActionResult> {
  try {
    const message = await fn();
    refresh();
    return { ok: true, message: message ?? undefined };
  } catch (error) {
    if (error instanceof dc.DailyCloseError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function saveDailyCloseAction(input: dc.CloseInput) {
  const user = await requireUser();
  return run(async () => {
    await dc.saveDailyClose(user, input);
    return "实收已保存（还没确认）";
  });
}

export async function confirmDailyCloseAction(input: dc.CloseInput) {
  const user = await requireUser();
  return run(async () => {
    const result = await dc.confirmDailyClose(user, input);
    return result.diffs.length ? `日结 ${result.closeNo} 已确认，${result.diffs.length} 项差异已留痕` : `日结 ${result.closeNo} 已确认，全部对上`;
  });
}

export async function reopenDailyCloseAction(storeId: number, bizDate: string, reason: string) {
  const user = await requireUser();
  return run(async () => {
    await dc.reopenDailyClose(user, storeId, dc.parseBizDate(bizDate), reason);
    return "已撤销日结，当天单据解锁";
  });
}
