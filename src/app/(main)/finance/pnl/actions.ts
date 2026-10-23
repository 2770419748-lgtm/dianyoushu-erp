"use server";

import { revalidatePath } from "next/cache";
import type { FixedExpenseCategoryKey } from "@/lib/pnl";
import { requireWritableUser } from "@/server/license/license-service";
import { PnlError, saveFixedExpenses } from "@/server/finance/pnl-service";

// 门店收支和利润表（口径第 19 节）：录门店固定支出（店长本店、总部）。

export async function saveFixedAction(storeId: number, month: string, items: { category: FixedExpenseCategoryKey; amountFen: number; note: string }[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireWritableUser();
  try {
    await saveFixedExpenses(user, { storeId, month, items });
    revalidatePath("/finance/pnl");
    return { ok: true };
  } catch (error) {
    if (error instanceof PnlError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "保存失败，请稍后再试" };
  }
}
