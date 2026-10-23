import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { ReminderStage } from "@/generated/prisma/enums";
import { daysUntil, entitlementPeriod, stageDateRange, type ReminderStageKey } from "@/lib/entitlement";
import { canFollowUpReminders, canRunReminderScan, canSell } from "@/server/auth/permissions";
import { assertStoreAccess, PermissionError, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { todayBizDate } from "@/server/stock/doc-no";

// 服务权益（口径第 12 节）：碎屏险、延保这类服务类商品开单时每行生成一条权益，
// 退货退掉服务或销售单作废时置失效；过没过期按到期日算，不单独存状态。
// 到期提醒分两档（剩 8～30 天、剩 0～7 天），每档对同一条权益只生成一次（唯一约束兜底）。
// 退了机器、没退服务时权益记 deviceReturnedAt（见 return-service），页面上标“机器已退回”。

export class EntitlementError extends Error {}

type Tx = Prisma.TransactionClient;

export interface EntitlementLine {
  salesOrderItemId: number;
  skuId: number;
  deviceId: number | null;
  months: number;
  kind: "SCREEN_INSURANCE" | "EXTENDED_WARRANTY" | "OTHER" | null; // 延保从保修到期次日起算
}

/** 开单事务里调用：每个服务行一条权益，生效日 = 营业日 */
export async function createEntitlementsTx(tx: Tx, input: { customerId: number; storeId: number; salesOrderId: number; bizDate: Date; lines: EntitlementLine[] }) {
  if (input.lines.length === 0) return 0;
  const result = await tx.serviceEntitlement.createMany({
    data: input.lines.map((l) => ({
      customerId: input.customerId,
      storeId: input.storeId,
      salesOrderId: input.salesOrderId,
      salesOrderItemId: l.salesOrderItemId,
      skuId: l.skuId,
      deviceId: l.deviceId,
      ...entitlementPeriod(l.kind, input.bizDate, l.months),
    })),
  });
  return result.count;
}

/** 作废整张销售单，或退货退掉了服务行：对应权益置失效（不删除） */
export async function voidEntitlementsTx(tx: Tx, where: { salesOrderId: number } | { salesOrderItemIds: number[] }) {
  const filter = "salesOrderId" in where ? { salesOrderId: where.salesOrderId } : { salesOrderItemId: { in: where.salesOrderItemIds } };
  const result = await tx.serviceEntitlement.updateMany({ where: { ...filter, status: "ACTIVE" }, data: { status: "VOIDED", voidedAt: new Date() } });
  return result.count;
}

function shape<T extends { startedOn: Date; expiresOn: Date }>(row: T, today: Date) {
  return { ...row, daysLeft: daysUntil(row.expiresOn, today), daysToStart: daysUntil(row.startedOn, today) };
}

/** 客户详情页的权益列表：客户档案全公司共享，权益也不分门店（口径第 8 节） */
export async function listCustomerEntitlements(customerId: number) {
  const today = todayBizDate();
  const rows = await prisma.serviceEntitlement.findMany({
    where: { customerId },
    orderBy: [{ status: "asc" }, { expiresOn: "asc" }],
    include: {
      sku: { select: { name: true, serviceMonths: true } },
      device: { select: { code: true } },
      store: { select: { code: true, name: true } },
    },
  });
  return rows.map((r) => shape(r, today));
}

export type CustomerEntitlement = Awaited<ReturnType<typeof listCustomerEntitlements>>[number];

// ---------- 到期名单 ----------

export const EXPIRING_PAGE_SIZE = 20;

/** 到期名单：按档位区间筛有效权益，按门店范围看（店员、店长本店，区域经理辖区只读，总部全部） */
export async function listExpiringEntitlements(user: CurrentUser, query: { stage: ReminderStageKey; storeId?: number; mine?: boolean; page?: number }) {
  const today = todayBizDate();
  const { from, to } = stageDateRange(query.stage, today);
  const page = clampPage(query.page);
  const where: Prisma.ServiceEntitlementWhereInput = {
    AND: [
      storeScopeWhere(user),
      query.storeId ? { storeId: query.storeId } : {},
      query.mine ? { salesOrder: { salespersonId: user.id } } : {}, // 跟进人默认是开单的店员
      { status: "ACTIVE", expiresOn: { gte: from, lte: to } },
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.serviceEntitlement.findMany({
      where,
      orderBy: [{ expiresOn: "asc" }, { id: "asc" }],
      skip: (page - 1) * EXPIRING_PAGE_SIZE,
      take: EXPIRING_PAGE_SIZE,
      include: {
        customer: { select: { id: true, name: true, phoneMasked: true } },
        sku: { select: { name: true } },
        device: { select: { code: true } },
        store: { select: { code: true, name: true } },
        salesOrder: { select: { orderNo: true, salesperson: { select: { name: true } } } },
        reminders: { where: { stage: query.stage }, include: { contactedBy: { select: { name: true } } } },
      },
    }),
    prisma.serviceEntitlement.count({ where }),
  ]);
  return {
    rows: rows.map(({ customer, reminders, ...r }) => ({
      ...shape(r, today),
      customer: { id: customer.id, name: customer.name, phoneMasked: customer.phoneMasked },
      reminder: reminders[0] ?? null,
    })),
    total,
    page,
    pageSize: EXPIRING_PAGE_SIZE,
    canOpenCustomer: canSell(user.role),
    canFollowUp: canFollowUpReminders(user.role),
    canScan: canRunReminderScan(user.role),
  };
}

export type ExpiringEntitlementRow = Awaited<ReturnType<typeof listExpiringEntitlements>>["rows"][number];

/**
 * 生成到期提醒：今天落在某一档区间、这一档还没提醒过的有效权益，各生成一条。
 * 每天由每日任务（pnpm daily，服务器上配定时任务）跑一次，也可以在到期名单页手动点；重复跑不会重复生成（唯一约束 + skipDuplicates）。
 * 第一次扫到时已经只剩 7 天以内的，只生成 0～7 天这一档。
 */
export async function scanEntitlementReminders(options: { today?: Date; storeIds?: number[]; client?: Tx } = {}) {
  const today = options.today ?? todayBizDate();
  const db = options.client ?? prisma; // 测试里传事务，跑完回滚
  const created: Record<ReminderStageKey, number> = { T30: 0, T7: 0 };
  for (const stage of ["T30", "T7"] as const) {
    const { from, to } = stageDateRange(stage, today);
    const due = await db.serviceEntitlement.findMany({
      where: {
        status: "ACTIVE",
        expiresOn: { gte: from, lte: to },
        ...(options.storeIds ? { storeId: { in: options.storeIds } } : {}),
        reminders: { none: { stage: stage as ReminderStage } },
      },
      select: { id: true },
    });
    if (due.length === 0) continue;
    const result = await db.entitlementReminder.createMany({ data: due.map((d) => ({ entitlementId: d.id, stage: stage as ReminderStage })), skipDuplicates: true });
    created[stage] = result.count;
  }
  return created;
}

/** 到期名单页的“生成提醒”：店长只扫本店，总部扫全部 */
export async function runReminderScan(user: CurrentUser) {
  if (!canRunReminderScan(user.role)) throw new EntitlementError("只有店长和总部能生成提醒");
  const storeIds = user.role === "HQ" ? undefined : user.storeId ? [user.storeId] : [];
  const created = await scanEntitlementReminders({ storeIds });
  await writeAudit({ userId: user.id, action: "entitlement.reminder_scan", detail: { ...created, scope: storeIds ?? "all" } });
  return created;
}

/** 门店联系过客户后记一笔（谁、什么时候、结果） */
export async function markReminderContacted(user: CurrentUser, reminderId: number, note: unknown) {
  if (!canFollowUpReminders(user.role)) throw new EntitlementError("你的角色不能跟进到期提醒");
  const reminder = await prisma.entitlementReminder.findUnique({ where: { id: reminderId }, include: { entitlement: { include: { store: { select: { id: true, regionId: true } } } } } });
  if (!reminder) throw new EntitlementError("提醒不存在");
  try {
    assertStoreAccess(user, reminder.entitlement.store);
  } catch (error) {
    if (error instanceof PermissionError) throw new EntitlementError("不是你门店的客户");
    throw error;
  }
  const text = typeof note === "string" ? note.trim().slice(0, 100) || null : null;
  // 条件写入：两个人同时点“已联系”只记第一个
  const changed = await prisma.entitlementReminder.updateMany({ where: { id: reminderId, contactedAt: null }, data: { contactedAt: new Date(), contactedById: user.id, note: text } });
  if (changed.count === 0) throw new EntitlementError("这条提醒已经记过联系了");
  await writeAudit({ userId: user.id, action: "entitlement.reminder_contacted", entity: "entitlement_reminder", entityId: reminderId, detail: { entitlementId: reminder.entitlementId, stage: reminder.stage, note: text } });
}
