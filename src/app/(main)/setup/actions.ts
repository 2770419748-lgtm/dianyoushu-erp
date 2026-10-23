"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { markSetupDone, saveCompany, savePaymentMethods, saveSwitches, SettingsError } from "@/server/settings/settings-service";

// 系统设置 / 初始化向导（口径第 21 节）：都是总部的操作；规则在服务层。

export type SetupActionResult = { ok: true } | { ok: false; error: string };

async function run(fn: () => Promise<void>): Promise<SetupActionResult> {
  try {
    await fn();
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    if (error instanceof SettingsError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function saveCompanyAction(input: { name: string; receiptTitle?: string; phone?: string; address?: string }) {
  const user = await requireWritableUser();
  return run(() => saveCompany(user, input));
}

export async function savePaymentMethodsAction(methods: string[]) {
  const user = await requireWritableUser();
  return run(() => savePaymentMethods(user, methods));
}

export async function saveSwitchesAction(input: { tradeInIdRequired?: boolean }) {
  const user = await requireWritableUser();
  return run(() => saveSwitches(user, input));
}

export async function markSetupDoneAction(done: boolean) {
  const user = await requireWritableUser();
  return run(() => markSetupDone(user, done));
}
