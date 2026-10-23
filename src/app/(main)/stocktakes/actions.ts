"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { PermissionError } from "@/server/auth/scope";
import * as stocktake from "@/server/stocktake/stocktake-service";
import { ApprovalRequiredError } from "@/server/approval/approval-check";
import { submitForApproval } from "@/server/approval/approval-service";

/** approval：触发了审批规则，这次没做，存成了审批单（口径第 17 节） */
export type StocktakeActionResult = { ok: true; id?: number; info?: string } | { ok: false; error: string; approval?: { id: number; requestNo: string } };

async function run(fn: () => Promise<{ id?: number; info?: string } | void>, onApproval?: (error: ApprovalRequiredError) => Promise<StocktakeActionResult>): Promise<StocktakeActionResult> {
  try {
    const result = await fn();
    revalidatePath("/stocktakes");
    revalidatePath("/stocktakes/[id]", "page");
    revalidatePath("/stock");
    revalidatePath("/stock/ledger");
    return { ok: true, id: result?.id, info: result?.info };
  } catch (error) {
    if (error instanceof ApprovalRequiredError && onApproval) {
      revalidatePath("/approvals");
      return onApproval(error);
    }
    if (error instanceof stocktake.StocktakeError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function createStocktakeAction(input: { storeId: number; note?: string }) {
  const user = await requireWritableUser();
  return run(() => stocktake.createStocktake(user, input));
}

export async function enterCountsAction(id: number, input: stocktake.EnterCountsInput) {
  const user = await requireWritableUser();
  return run(async () => {
    const result = await stocktake.enterCounts(user, id, input);
    const info = `识别 ${result.scanned} 个串号，对上 ${result.matched} 个${result.unexpected.length ? `；${result.unexpected.length} 个不在应有清单里（${result.unexpected.slice(0, 3).join("、")}），请核实后由总部走入库` : ""}`;
    return { info };
  });
}

export async function confirmStocktakeAction(id: number) {
  const user = await requireWritableUser();
  return run(
    () => stocktake.confirmStocktake(user, id),
    (error) => submitForApproval(user, error, { action: "STOCKTAKE", stocktakeId: id, details: [] }),
  );
}

export async function voidStocktakeAction(id: number) {
  const user = await requireWritableUser();
  return run(() => stocktake.voidStocktake(user, id));
}
