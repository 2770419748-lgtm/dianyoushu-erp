"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { importPlatformResults, savePolicy, simulateReview, simulateSettle, subsidyActions, SubsidyError } from "@/server/subsidy/subsidy-service";

// 国补的 Server Function：只做"取当前用户 → 调服务层 → 刷新页面"，规则都在服务层（口径第 15 节）。

export type SubsidyActionResult = { ok: true; message?: string } | { ok: false; error: string };

async function run(fn: () => Promise<string | void>): Promise<SubsidyActionResult> {
  try {
    const message = await fn();
    revalidatePath("/subsidy", "layout");
    return { ok: true, message: message ?? undefined };
  } catch (error) {
    if (error instanceof SubsidyError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

function summary(r: { applied: number; skipped: unknown[]; unmatched: unknown[] }): string {
  return `处理了 ${r.applied} 张${r.skipped.length ? `，${r.skipped.length} 行状态不对没处理` : ""}${r.unmatched.length ? `，${r.unmatched.length} 行找不到国补单` : ""}`;
}

export async function submitClaimAction(id: number, invoiceNo: string) {
  const user = await requireUser();
  return run(async () => {
    await subsidyActions.submit(user, id, invoiceNo);
    return "已提交平台审核";
  });
}

export async function markReturnedAction(id: number) {
  const user = await requireUser();
  return run(async () => {
    await subsidyActions.markReturned(user, id);
    return "已标记退回平台";
  });
}

export async function importResultsAction(csv: string) {
  const user = await requireUser();
  return run(async () => summary(await importPlatformResults(user, csv)));
}

export async function simulateReviewAction() {
  const user = await requireUser();
  return run(async () => `平台审核（模拟）：${summary(await simulateReview(user))}`);
}

export async function simulateSettleAction() {
  const user = await requireUser();
  return run(async () => `平台到账（模拟）：${summary(await simulateSettle(user))}`);
}

export async function savePolicyAction(input: { categoryId: number; rateBp: number; capFen: number; priceCapFen: number; startsOn: string; endsOn: string; isActive: boolean; note?: string }) {
  const user = await requireUser();
  return run(async () => {
    await savePolicy(user, input);
    return "已保存，以后开单按新政策算";
  });
}
