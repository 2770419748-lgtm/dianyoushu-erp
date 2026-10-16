"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import * as tradeIn from "@/server/tradein/trade-in-service";

export type TradeInActionResult =
  | { ok: true; tradeIn?: { id: number; orderNo: string; appraisedFen: number; deviceCode: string; modelName: string } }
  | { ok: false; error: string };

function refresh() {
  revalidatePath("/trade-ins");
  revalidatePath("/trade-ins/stock");
  revalidatePath("/stock");
  revalidatePath("/stock/ledger");
}

function toError(error: unknown): TradeInActionResult {
  if (error instanceof tradeIn.TradeInError || error instanceof PermissionError) return { ok: false, error: error.message };
  console.error(error);
  return { ok: false, error: "操作失败，请稍后再试" };
}

export async function createTradeInAction(input: tradeIn.TradeInInput): Promise<TradeInActionResult> {
  const user = await requireUser();
  try {
    const created = await tradeIn.createTradeIn(user, input);
    refresh();
    return { ok: true, tradeIn: created };
  } catch (error) {
    return toError(error);
  }
}

export async function refurbishAction(deviceId: number): Promise<TradeInActionResult> {
  const user = await requireUser();
  try {
    await tradeIn.refurbish(user, deviceId);
    refresh();
    return { ok: true };
  } catch (error) {
    return toError(error);
  }
}
