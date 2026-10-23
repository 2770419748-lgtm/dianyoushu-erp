"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { PermissionError } from "@/server/auth/scope";
import { isUniqueViolation } from "@/server/db-errors";
import {
  carrierActions,
  CarrierError,
  generateSimulatedSettlement,
  importSettlementCsv,
  saveCommissionRule,
  syncSimulatedStatus,
  type CarrierBusinessInput,
} from "@/server/carrier/carrier-service";

// 运营商业务的 Server Function：只做"取当前用户 → 调服务层 → 刷新页面"，规则都在服务层（口径第 14 节）。

export type CarrierActionResult = { ok: true; id?: number; message?: string } | { ok: false; error: string };

async function run(fn: () => Promise<{ id?: number; message?: string } | void>): Promise<CarrierActionResult> {
  try {
    const result = await fn();
    revalidatePath("/carrier", "layout");
    return { ok: true, id: result?.id, message: result?.message };
  } catch (error) {
    if (error instanceof CarrierError || error instanceof PermissionError) return { ok: false, error: error.message };
    // 两个人同时登记同一个受理单号、同时对同一个月的账：数据库唯一约束兜底
    if (isUniqueViolation(error)) return { ok: false, error: "刚被别人登记或对过账了，刷新看一下" };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function registerBusinessAction(input: CarrierBusinessInput) {
  const user = await requireWritableUser();
  return run(async () => {
    const r = await carrierActions.register(user, input);
    return { id: r.id, message: `已登记 ${r.orderNo}` };
  });
}

export async function confirmBusinessAction(id: number, activated: boolean, extra: { carrierOrderNo?: string; reason?: string }) {
  const user = await requireWritableUser();
  return run(() => carrierActions.confirm(user, id, { activated, ...extra }));
}

export async function voidBusinessAction(id: number, reason: string) {
  const user = await requireWritableUser();
  return run(() => carrierActions.void(user, id, reason));
}

export async function syncSimulatedAction() {
  const user = await requireWritableUser();
  return run(async () => {
    const r = await syncSimulatedStatus(user);
    return { message: r.activated + r.failed === 0 ? "没有等着确认的业务" : `运营商系统（模拟）回来了：开通 ${r.activated} 笔，失败 ${r.failed} 笔` };
  });
}

export async function saveRuleAction(input: { carrier: string; bizType: string; commissionFen: number; clawbackMonths: number; isActive: boolean; note?: string }) {
  const user = await requireWritableUser();
  return run(async () => {
    await saveCommissionRule(user, input);
  });
}

export async function importSettlementAction(input: { carrier: string; month: string; csv: string }) {
  const user = await requireWritableUser();
  return run(async () => {
    const r = await importSettlementCsv(user, input);
    return { id: r.id, message: `已导入 ${r.settlementNo}` };
  });
}

export async function simulateSettlementAction(input: { carrier: string; month: string }) {
  const user = await requireWritableUser();
  return run(async () => {
    const r = await generateSimulatedSettlement(user, input);
    return { id: r.id, message: `已生成模拟结算单 ${r.settlementNo} 并对完账` };
  });
}
