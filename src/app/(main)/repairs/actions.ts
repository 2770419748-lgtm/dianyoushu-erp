"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { createRepair, lookupRepairDevice, repairActions, RepairError, type RepairIntakeInput, type RepairQuoteInput } from "@/server/repair/repair-service";

// 售后维修的 Server Function：只做"取当前用户 → 调服务层 → 刷新页面"，规则都在服务层（口径第 13 节）。

export type RepairActionResult = { ok: true; id?: number; orderNo?: string } | { ok: false; error: string };

async function run(fn: () => Promise<{ id: number; orderNo: string } | void>): Promise<RepairActionResult> {
  try {
    const result = await fn();
    revalidatePath("/repairs");
    revalidatePath("/repairs/[id]", "page");
    return { ok: true, id: result?.id, orderNo: result?.orderNo };
  } catch (error) {
    if (error instanceof RepairError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function lookupRepairDeviceAction(code: string) {
  const user = await requireUser();
  try {
    return await lookupRepairDevice(user, code);
  } catch (error) {
    if (error instanceof RepairError) return { kind: "error" as const, message: error.message };
    throw error;
  }
}

export async function createRepairAction(input: RepairIntakeInput) {
  const user = await requireUser();
  return run(() => createRepair(user, input));
}

export async function quoteRepairAction(id: number, input: RepairQuoteInput) {
  const user = await requireUser();
  return run(() => repairActions.quote(user, id, input));
}

export async function approveRepairAction(id: number) {
  const user = await requireUser();
  return run(() => repairActions.approve(user, id));
}

export async function declineRepairAction(id: number, note: string) {
  const user = await requireUser();
  return run(() => repairActions.decline(user, id, note));
}

export async function finishRepairAction(id: number, outcome: "REPAIRED" | "NOT_REPAIRED", note: string) {
  const user = await requireUser();
  return run(() => repairActions.finish(user, id, outcome, note));
}

export async function pickupRepairAction(id: number, payments: { method: string; amountFen: number }[]) {
  const user = await requireUser();
  return run(() => repairActions.pickup(user, id, payments));
}

export async function voidRepairAction(id: number, reason: string) {
  const user = await requireUser();
  return run(() => repairActions.void(user, id, reason));
}
