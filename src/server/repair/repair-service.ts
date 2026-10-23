import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { FaultCategory, RepairOutcome, RepairPayer, RepairStatus } from "@/generated/prisma/enums";
import { daysUntil } from "@/lib/entitlement";
import { formatDate } from "@/lib/format";
import { isValidFen, MAX_AMOUNT_FEN } from "@/lib/limits";
import { FAULT_LABELS, payerOptions, REPAIR_PAYER_LABELS, repairChargeFen, type ServiceKindKey, warrantyEndsOn } from "@/lib/repair";
import { DEVICE_STATUS_LABELS } from "@/lib/stock-labels";
import { canHandleRepair, canSeeCost, canVoidRepair } from "@/server/auth/permissions";
import { assertStoreAccess, canAccessStoreSafe, PermissionError, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { DAY_CLOSED_MESSAGE, isDayClosed, lockStoreDay } from "@/server/dailyclose/guard";
import { lockRow } from "@/server/db-lock";
import { type Db, withTx } from "@/server/db-tx";
import { buildSalePayments, PaymentError } from "@/server/sales/payments";
import { nextDocNo, todayBizDate } from "@/server/stock/doc-no";
import { deviceCodeWhere } from "@/server/stock/stock-service";

// 售后维修（口径第 13 节）：接件 → 检测报价 → 维修 → 取机结算。
// 客户的机器不算门店库存：全程不动库存、不写库存流水，机器状态不变；按码找到本系统卖出的机器，带出购买记录、保修和碎屏险 / 延保。
// 谁来付按 src/lib/repair.ts 的规则校验；碎屏险在取机结算时变“已理赔”（只能用一次），延保期内不限次数。

export class RepairError extends Error {}

type Tx = Prisma.TransactionClient;

const FAULTS: FaultCategory[] = ["SCREEN", "BATTERY", "BOARD", "CAMERA", "WATER", "SOFTWARE", "OTHER"];
const PAYERS: RepairPayer[] = ["CUSTOMER", "WARRANTY", "SCREEN_INSURANCE", "EXTENDED_WARRANTY"];
const OPEN_STATUSES: RepairStatus[] = ["RECEIVED", "QUOTED", "REPAIRING", "READY"];
/** 同一个码同时只能有一张没完结的维修单：接件时按码排队（两个店员同时接同一台） */
const REPAIR_CODE_LOCK_NS = -73;

function assertCanHandle(user: CurrentUser) {
  if (!canHandleRepair(user.role)) throw new RepairError("你的角色不能办售后");
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function wrapAccess(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (error instanceof PermissionError) throw new RepairError(error.message);
    throw error;
  }
}

// ---------- 接件前按码查机器 ----------

/** 机器的显示名：品牌 + SKU；回收机再卖出去的用回收单上的真实机型 */
function deviceModelName(device: { sku: { name: string; model: { brand: { name: string } } }; tradeInOrder: { modelName: string } | null }): string {
  return device.tradeInOrder?.modelName ?? `${device.sku.model.brand.name} ${device.sku.name}`;
}

/** 这台机器最近一次在本系统卖出、没退的那一单 */
async function lastSaleOf(db: Db, deviceId: number) {
  const line = await db.salesOrderItem.findFirst({
    where: { deviceId, order: { status: "COMPLETED" } },
    orderBy: { id: "desc" },
    select: { qty: true, returnedQty: true, order: { select: { id: true, orderNo: true, bizDate: true, customer: { select: { id: true, name: true, phoneMasked: true } }, store: { select: { name: true } } } } },
  });
  return line && line.returnedQty < line.qty ? line.order : null;
}

/** 接件页扫码 / 输码后的提示：本店卖的机器带出购买记录、保修、碎屏险和延保；外面买的手填机型；店里库存的不能接 */
export async function lookupRepairDevice(user: CurrentUser, rawCode: string, db: Db = prisma) {
  assertCanHandle(user);
  const code = rawCode.trim();
  if (!code) return { kind: "empty" as const };
  const device = await db.device.findFirst({
    where: deviceCodeWhere(code),
    include: { sku: { select: { name: true, model: { select: { brand: { select: { name: true } } } } } }, tradeInOrder: { select: { modelName: true } } },
  });
  const openRepair = await db.repairOrder.findFirst({ where: { deviceCode: device?.code ?? code.toUpperCase(), status: { in: OPEN_STATUSES } }, select: { id: true, orderNo: true } });
  if (!device) return { kind: "outside" as const, code: code.toUpperCase(), openRepair };
  if (device.status !== "SOLD") return { kind: "in_stock" as const, code: device.code, statusLabel: DEVICE_STATUS_LABELS[device.status], openRepair };
  const sale = await lastSaleOf(db, device.id);
  const today = todayBizDate();
  // 保这台机器的服务，加上买这台机器的客户名下不绑机器的碎屏险、延保（报价时也按这个范围算，见 coverageEntitlements）
  const entitlements = await db.serviceEntitlement.findMany({
    where: {
      status: "ACTIVE",
      expiresOn: { gte: today },
      OR: [
        { deviceId: device.id, deviceReturnedAt: null },
        ...(sale?.customer ? [{ customerId: sale.customer.id, deviceId: null, sku: { serviceKind: { in: ["SCREEN_INSURANCE", "EXTENDED_WARRANTY"] as ServiceKindKey[] } } }] : []),
      ],
    },
    orderBy: { expiresOn: "desc" },
    include: { sku: { select: { name: true, serviceKind: true } } },
  });
  return {
    kind: "ours" as const,
    code: device.code,
    modelName: deviceModelName(device),
    sale: sale ? { orderNo: sale.orderNo, bizDate: sale.bizDate, storeName: sale.store.name, customer: sale.customer ? { id: sale.customer.id, name: sale.customer.name, phoneMasked: sale.customer.phoneMasked } : null } : null,
    warrantyEndsOn: sale ? warrantyEndsOn(sale.bizDate) : null,
    inWarranty: sale ? daysUntil(warrantyEndsOn(sale.bizDate), today) >= 0 : false,
    entitlements: entitlements.map((e) => ({
      id: e.id,
      name: (e.deviceId ? e.sku.name : `${e.sku.name}（客户名下，不绑机器）`) + (daysUntil(e.startedOn, today) > 0 ? `（${formatDate(e.startedOn)} 起生效）` : ""),
      expiresOn: e.expiresOn,
      daysLeft: daysUntil(e.expiresOn, today),
    })),
    openRepair,
  };
}

export type RepairDeviceLookup = Awaited<ReturnType<typeof lookupRepairDevice>>;

// ---------- 接件 ----------

export interface RepairIntakeInput {
  storeId: unknown;
  customerId: unknown;
  code: unknown; // 机器的 SN / IMEI
  modelName?: unknown; // 外面买的机器手填
  faultCategory: unknown;
  faultDescription: unknown;
  appearance?: unknown;
}

export async function createRepairTx(tx: Tx, user: CurrentUser, input: RepairIntakeInput) {
  assertCanHandle(user);
  const storeId = Number(input.storeId);
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true, isActive: true } });
  if (!store || !store.isActive) throw new RepairError("门店不存在或已停用");
  wrapAccess(() => assertStoreAccess(user, store));
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) throw new RepairError("要选客户：修好了要联系客户取机");
  if (!(await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) throw new RepairError("客户不存在");
  const typed = text(input.code, 40);
  if (!/^[A-Za-z0-9-]{4,40}$/.test(typed)) throw new RepairError("机器的码填 SN 或 IMEI（4～40 位字母数字）");
  const faultCategory = input.faultCategory as FaultCategory;
  if (!FAULTS.includes(faultCategory)) throw new RepairError("请选故障类型");
  const faultDescription = text(input.faultDescription, 200);
  if (!faultDescription) throw new RepairError("写一下故障描述");
  const appearance = text(input.appearance, 200) || null;

  const device = await tx.device.findFirst({
    where: deviceCodeWhere(typed),
    include: { sku: { select: { name: true, model: { select: { brand: { select: { name: true } } } } } }, tradeInOrder: { select: { modelName: true } } },
  });
  if (device && device.status !== "SOLD") throw new RepairError(`${device.code} 还在店里（${DEVICE_STATUS_LABELS[device.status]}），不是客户的机器，不能接件`);
  // 外面买的机器码统一存大写：snoutcase1 和 SNOUTCASE1 是同一台，不能各开一张没完结的单
  const deviceCode = device?.code ?? typed.toUpperCase();
  const modelName = device ? deviceModelName(device) : text(input.modelName, 60);
  if (!modelName) throw new RepairError("外面买的机器，写一下机型");

  // 按码排队后再查有没有没完结的单：两个店员同时接同一台，只有一个能成
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REPAIR_CODE_LOCK_NS}::int, hashtext(${deviceCode}))`;
  const open = await tx.repairOrder.findFirst({ where: { deviceCode, status: { in: OPEN_STATUSES } }, select: { orderNo: true } });
  if (open) throw new RepairError(`这台机器已经有一张没完结的维修单 ${open.orderNo}`);
  const sale = device ? await lastSaleOf(tx, device.id) : null;

  const orderNo = await nextDocNo(tx, "WX");
  const repair = await tx.repairOrder.create({
    data: {
      orderNo,
      storeId,
      customerId,
      receivedById: user.id,
      deviceId: device?.id ?? null,
      deviceCode,
      modelName,
      salesOrderId: sale?.id ?? null,
      purchasedOn: sale?.bizDate ?? null,
      faultCategory,
      faultDescription,
      appearance,
    },
  });
  await writeAudit({ userId: user.id, action: "repair.create", entity: "repair_order", entityId: repair.id, detail: { orderNo, deviceCode, fault: faultCategory, ours: device !== null } }, tx);
  return { id: repair.id, orderNo };
}

export async function createRepair(user: CurrentUser, input: RepairIntakeInput) {
  return prisma.$transaction((tx) => createRepairTx(tx, user, input));
}

// ---------- 报价、维修 ----------

/** 锁住维修单再读：两个人同时点只做一次（和单据级防并发一样） */
async function lockRepair(tx: Tx, user: CurrentUser, id: number) {
  if (!(await lockRow(tx, "repair_orders", id))) throw new RepairError("维修单不存在");
  const repair = await tx.repairOrder.findUniqueOrThrow({ where: { id }, include: { store: { select: { id: true, regionId: true } } } });
  wrapAccess(() => assertStoreAccess(user, repair.store));
  return repair;
}

/** 这张单能用来付钱的碎屏险、延保：客户生效中的服务，保的就是这台机器（服务没绑机器的按客户算） */
async function coverageEntitlements(db: Db, repair: { customerId: number; deviceId: number | null }) {
  const rows = await db.serviceEntitlement.findMany({
    where: {
      status: "ACTIVE",
      sku: { serviceKind: { in: ["SCREEN_INSURANCE", "EXTENDED_WARRANTY"] } },
      OR: [...(repair.deviceId ? [{ deviceId: repair.deviceId, deviceReturnedAt: null }] : []), { customerId: repair.customerId, deviceId: null }],
    },
    orderBy: { expiresOn: "desc" },
    include: { sku: { select: { name: true, serviceKind: true } } },
  });
  return rows.map((r) => ({ id: r.id, kind: r.sku.serviceKind as ServiceKindKey, startedOn: r.startedOn, expiresOn: r.expiresOn, name: r.sku.name }));
}

/** 报价那天（营业日）：保修、服务有没有过期按报价那天算，取机晚几天不影响 */
function quoteDayOf(repair: { quotedAt: Date | null }): Date {
  return repair.quotedAt ? new Date(formatDate(repair.quotedAt)) : todayBizDate();
}

/** 接件时带出的购买记录还算不算：原销售单后来退了、作废了，就不能再按本店保修 */
async function currentPurchasedOn(db: Db, repair: { deviceId: number | null; salesOrderId: number | null; purchasedOn: Date | null }): Promise<Date | null> {
  if (!repair.deviceId || !repair.salesOrderId || !repair.purchasedOn) return null;
  const sale = await lastSaleOf(db, repair.deviceId);
  return sale?.id === repair.salesOrderId ? repair.purchasedOn : null;
}

/**
 * 取机前再核一遍报价时选的付法：日期按报价那天，碎屏险 / 延保和原销售单按现在。
 * 报价后服务被退掉、被别的单先理赔了、原单退货了，返回原因（要重新报价）；还成立返回 null。自费、没修的不用核。
 */
async function stalePayerReason(
  db: Db,
  repair: { outcome: RepairOutcome | null; payer: RepairPayer | null; quotedAt: Date | null; faultCategory: FaultCategory; customerId: number; deviceId: number | null; salesOrderId: number | null; purchasedOn: Date | null; entitlementId: number | null },
): Promise<string | null> {
  if (repair.outcome !== "REPAIRED" || !repair.payer || repair.payer === "CUSTOMER") return null;
  const purchasedOn = await currentPurchasedOn(db, repair);
  if (repair.payer === "WARRANTY" && !purchasedOn) return "原销售单已经退货或作废，不能再按本店保修";
  const entitlements = repair.entitlementId ? (await coverageEntitlements(db, repair)).filter((e) => e.id === repair.entitlementId) : [];
  const option = payerOptions({ fault: repair.faultCategory, today: quoteDayOf(repair), purchasedOn, entitlements }).find((o) => o.payer === repair.payer)!;
  if (option.allowed) return null;
  return option.reason.startsWith("没有生效中的") ? `报价时用的那份${REPAIR_PAYER_LABELS[repair.payer]}已经退掉、理赔过或失效了` : option.reason;
}

/** 这张单现在能选谁来付：购买记录按原销售单还在不在算，原单退了、作废了的保修那一项说清楚原因 */
async function repairPayerOptions(db: Db, repair: { faultCategory: FaultCategory; customerId: number; deviceId: number | null; salesOrderId: number | null; purchasedOn: Date | null }, day: Date) {
  const purchasedOn = await currentPurchasedOn(db, repair);
  const options = payerOptions({ fault: repair.faultCategory, today: day, purchasedOn, entitlements: await coverageEntitlements(db, repair) });
  return repair.salesOrderId && !purchasedOn ? options.map((o) => (o.payer === "WARRANTY" ? { ...o, allowed: false, reason: "原销售单已经退货或作废，不能再按本店保修" } : o)) : options;
}

export interface RepairQuoteInput {
  partsFen: unknown;
  laborFen: unknown;
  costFen?: unknown;
  payer: unknown;
  note?: unknown;
}

function fen(value: unknown, label: string): number {
  const n = Number(value ?? 0);
  if (!isValidFen(n)) throw new RepairError(`金额不对：${label}要在 0 到 ${MAX_AMOUNT_FEN / 1_000_000} 万元之间`);
  return n;
}

export async function quoteRepairTx(tx: Tx, user: CurrentUser, id: number, input: RepairQuoteInput, today = todayBizDate()) {
  assertCanHandle(user);
  const repair = await lockRepair(tx, user, id);
  // 修好了待取机的单也能重新报价：报价后碎屏险、延保、原销售单变了，取机前改付法（日期还按第一次报价那天算）
  const requote = repair.status === "READY" && repair.outcome === "REPAIRED";
  if (repair.status !== "RECEIVED" && repair.status !== "QUOTED" && !requote) throw new RepairError("只有已接件、已报价的单，或者修好了待取机的单能报价");
  const payer = input.payer as RepairPayer;
  if (!PAYERS.includes(payer)) throw new RepairError("请选谁来付");
  const partsFen = fen(input.partsFen, "配件费");
  const laborFen = fen(input.laborFen, "工时费");
  const costFen = fen(input.costFen, "维修成本");
  const option = (await repairPayerOptions(tx, repair, requote ? quoteDayOf(repair) : today)).find((o) => o.payer === payer)!;
  if (!option.allowed) throw new RepairError(`不能选“${REPAIR_PAYER_LABELS[payer]}”：${option.reason}`);
  const chargeFen = repairChargeFen(payer, partsFen, laborFen);
  if (chargeFen > MAX_AMOUNT_FEN) throw new RepairError("金额不对：应付太大了");
  await tx.repairOrder.update({
    where: { id },
    data: { ...(requote ? {} : { status: "QUOTED" as const, quotedAt: new Date() }), partsFen, laborFen, costFen, payer, entitlementId: option.entitlementId ?? null, chargeFen, repairNote: text(input.note, 200) || repair.repairNote },
  });
  await writeAudit({ userId: user.id, action: "repair.quote", entity: "repair_order", entityId: id, detail: { payer, partsFen, laborFen, chargeFen, ...(requote ? { requote: true } : {}) } }, tx);
}

/** 客户同意报价：开始修 */
export async function approveRepairTx(tx: Tx, user: CurrentUser, id: number) {
  assertCanHandle(user);
  const repair = await lockRepair(tx, user, id);
  if (repair.status !== "QUOTED") throw new RepairError("报价之后客户同意才能开始修");
  await tx.repairOrder.update({ where: { id }, data: { status: "REPAIRING", approvedAt: new Date() } });
  await writeAudit({ userId: user.id, action: "repair.approve", entity: "repair_order", entityId: id }, tx);
}

/** 客户不修：直接待取机，应付 0 */
export async function declineRepairTx(tx: Tx, user: CurrentUser, id: number, note: unknown) {
  assertCanHandle(user);
  const repair = await lockRepair(tx, user, id);
  if (repair.status !== "QUOTED") throw new RepairError("报价之后才能选客户不修");
  await tx.repairOrder.update({ where: { id }, data: { status: "READY", readyAt: new Date(), outcome: "NOT_REPAIRED", chargeFen: 0, repairNote: text(note, 200) || "客户不修" } });
  await writeAudit({ userId: user.id, action: "repair.decline", entity: "repair_order", entityId: id }, tx);
}

/** 修好了 / 修不好：进待取机；修不好的应付变 0 */
export async function finishRepairTx(tx: Tx, user: CurrentUser, id: number, outcome: unknown, note: unknown) {
  assertCanHandle(user);
  if (outcome !== "REPAIRED" && outcome !== "NOT_REPAIRED") throw new RepairError("选修好了还是修不好");
  const repair = await lockRepair(tx, user, id);
  if (repair.status !== "REPAIRING") throw new RepairError("维修中的单才能填结果");
  await tx.repairOrder.update({
    where: { id },
    data: { status: "READY", readyAt: new Date(), outcome: outcome as RepairOutcome, chargeFen: outcome === "NOT_REPAIRED" ? 0 : repair.chargeFen, repairNote: text(note, 200) || repair.repairNote },
  });
  await writeAudit({ userId: user.id, action: "repair.finish", entity: "repair_order", entityId: id, detail: { outcome } }, tx);
}

// ---------- 取机结算 ----------

/**
 * 取机结算：收款记在今天（进今天的日结和收银日报），当天已日结的门店不能结算；
 * 修好了、用碎屏险付的，这份碎屏险变“已理赔”（条件写入：同一份不能理赔两次）。
 */
export async function pickupRepairTx(tx: Tx, user: CurrentUser, id: number, payments: { method: unknown; amountFen: unknown }[]) {
  assertCanHandle(user);
  const head = await tx.repairOrder.findUnique({ where: { id }, select: { storeId: true, store: { select: { id: true, regionId: true } } } });
  if (!head) throw new RepairError("维修单不存在");
  wrapAccess(() => assertStoreAccess(user, head.store));
  const bizDate = todayBizDate();
  await lockStoreDay(tx, head.storeId, bizDate); // 和日结确认排队：确认算账时不会插进一笔维修收款
  if (await isDayClosed(tx, head.storeId, bizDate)) throw new RepairError(DAY_CLOSED_MESSAGE);
  const repair = await lockRepair(tx, user, id);
  if (repair.status !== "READY") throw new RepairError("待取机的单才能结算");
  const stale = await stalePayerReason(tx, repair);
  if (stale) throw new RepairError(`报价时选的“${REPAIR_PAYER_LABELS[repair.payer!]}”现在用不了：${stale}。请重新报价（比如改成自费）再结算`);
  let lines;
  try {
    lines = buildSalePayments(repair.chargeFen, 0, Array.isArray(payments) ? payments : []);
  } catch (error) {
    if (error instanceof PaymentError) throw new RepairError(error.message);
    throw error;
  }
  if (repair.outcome === "REPAIRED" && repair.payer === "SCREEN_INSURANCE" && repair.entitlementId) {
    const claimed = await tx.serviceEntitlement.updateMany({ where: { id: repair.entitlementId, status: "ACTIVE" }, data: { status: "CLAIMED" } });
    if (claimed.count === 0) throw new RepairError("这份碎屏险已经理赔过或失效了，请重新报价（比如改成自费）再结算");
  }
  await tx.repairOrder.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date(), closedById: user.id, bizDate } });
  if (lines.length > 0) await tx.payment.createMany({ data: lines.map((l) => ({ repairOrderId: id, method: l.method, amountFen: l.amountFen })) });
  await writeAudit({ userId: user.id, action: "repair.pickup", entity: "repair_order", entityId: id, detail: { chargeFen: repair.chargeFen, payments: lines.map((l) => l.method), claimed: repair.payer === "SCREEN_INSURANCE" && repair.outcome === "REPAIRED" } }, tx);
}

/** 作废：接错了、重复接件（店长、总部）；已完结的不能作废 */
export async function voidRepairTx(tx: Tx, user: CurrentUser, id: number, reason: unknown) {
  if (!canVoidRepair(user.role)) throw new RepairError("只有店长和总部能作废维修单");
  const repair = await lockRepair(tx, user, id);
  if (repair.status === "CLOSED" || repair.status === "VOIDED") throw new RepairError("已完结、已作废的单不能作废");
  const voidReason = text(reason, 200);
  if (!voidReason) throw new RepairError("写一下作废原因");
  await tx.repairOrder.update({ where: { id }, data: { status: "VOIDED", voidedAt: new Date(), voidedById: user.id, voidReason } });
  await writeAudit({ userId: user.id, action: "repair.void", entity: "repair_order", entityId: id, detail: { reason: voidReason } }, tx);
}

/** 页面用的不带 Tx 的版本 */
export const repairActions = {
  quote: (user: CurrentUser, id: number, input: RepairQuoteInput) => withTx(prisma, (tx) => quoteRepairTx(tx, user, id, input)),
  approve: (user: CurrentUser, id: number) => withTx(prisma, (tx) => approveRepairTx(tx, user, id)),
  decline: (user: CurrentUser, id: number, note: unknown) => withTx(prisma, (tx) => declineRepairTx(tx, user, id, note)),
  finish: (user: CurrentUser, id: number, outcome: unknown, note: unknown) => withTx(prisma, (tx) => finishRepairTx(tx, user, id, outcome, note)),
  pickup: (user: CurrentUser, id: number, payments: { method: unknown; amountFen: unknown }[]) => withTx(prisma, (tx) => pickupRepairTx(tx, user, id, payments)),
  void: (user: CurrentUser, id: number, reason: unknown) => withTx(prisma, (tx) => voidRepairTx(tx, user, id, reason)),
};

// ---------- 查询 ----------

export const REPAIR_PAGE_SIZE = 20;
export type RepairListView = "open" | "ready" | "closed" | "all";

const VIEW_STATUSES: Record<RepairListView, RepairStatus[] | null> = {
  open: ["RECEIVED", "QUOTED", "REPAIRING"],
  ready: ["READY"],
  closed: ["CLOSED", "VOIDED"],
  all: null,
};

/** 维修单列表：按门店范围（店员、店长本店，区域经理辖区，总部全部），可按码、单号、机型搜 */
export async function listRepairs(user: CurrentUser, query: { view?: RepairListView; storeId?: number; q?: string; page?: number }) {
  const page = clampPage(query.page);
  const view = query.view ?? "open";
  const q = (query.q ?? "").trim();
  const statuses = VIEW_STATUSES[view];
  const where: Prisma.RepairOrderWhereInput = {
    AND: [
      storeScopeWhere(user),
      query.storeId ? { storeId: query.storeId } : {},
      statuses ? { status: { in: statuses } } : {},
      q ? { OR: [{ orderNo: { contains: q, mode: "insensitive" } }, { deviceCode: { contains: q } }, { modelName: { contains: q, mode: "insensitive" } }] } : {},
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.repairOrder.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * REPAIR_PAGE_SIZE,
      take: REPAIR_PAGE_SIZE,
      include: { store: { select: { code: true, name: true } }, customer: { select: { name: true, phoneMasked: true } }, receivedBy: { select: { name: true } } },
    }),
    prisma.repairOrder.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      orderNo: r.orderNo,
      createdAt: r.createdAt,
      store: `${r.store.code} ${r.store.name}`,
      customer: `${r.customer.name} ${r.customer.phoneMasked}`,
      modelName: r.modelName,
      deviceCode: r.deviceCode,
      fault: FAULT_LABELS[r.faultCategory],
      status: r.status,
      payer: r.payer,
      chargeFen: r.chargeFen,
      receivedBy: r.receivedBy.name,
    })),
    total,
    page,
    pageSize: REPAIR_PAGE_SIZE,
    canCreate: canHandleRepair(user.role),
  };
}

export type RepairRow = Awaited<ReturnType<typeof listRepairs>>["rows"][number];

/** 维修单详情：成本只给店长以上；还没报价时带出谁能付的选项（为什么能 / 不能） */
export async function getRepair(user: CurrentUser, id: number) {
  const repair = await prisma.repairOrder.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, code: true, name: true, regionId: true } },
      customer: { select: { id: true, name: true, phoneMasked: true } },
      receivedBy: { select: { name: true } },
      closedBy: { select: { name: true } },
      voidedBy: { select: { name: true } },
      device: { select: { code: true } },
      salesOrder: { select: { id: true, orderNo: true, store: { select: { id: true, regionId: true } } } },
      entitlement: { select: { id: true, status: true, expiresOn: true, sku: { select: { name: true } } } },
      payments: { orderBy: { id: "asc" } },
    },
  });
  if (!repair) return null;
  wrapAccess(() => assertStoreAccess(user, repair.store));
  const today = todayBizDate();
  const payerStale = repair.status === "READY" ? await stalePayerReason(prisma, repair) : null;
  const quoting = repair.status === "RECEIVED" || repair.status === "QUOTED" || payerStale !== null;
  const options = quoting ? await repairPayerOptions(prisma, repair, repair.status === "READY" ? quoteDayOf(repair) : today) : [];
  const showCost = canSeeCost(user.role);
  return {
    ...repair,
    costFen: showCost ? repair.costFen : null,
    customer: { id: repair.customer.id, name: repair.customer.name, phoneMasked: repair.customer.phoneMasked },
    salesOrder: repair.salesOrder ? { id: repair.salesOrder.id, orderNo: repair.salesOrder.orderNo, canOpen: canAccessStoreSafe(user, repair.salesOrder.store) } : null,
    warrantyEndsOn: repair.purchasedOn ? warrantyEndsOn(repair.purchasedOn) : null,
    payerOptions: options,
    payerStale,
    todayClosed: await isDayClosed(prisma, repair.storeId, today),
    can: {
      handle: canHandleRepair(user.role),
      void: canVoidRepair(user.role) && repair.status !== "CLOSED" && repair.status !== "VOIDED",
      seeCost: showCost,
    },
  };
}

export type RepairDetail = NonNullable<Awaited<ReturnType<typeof getRepair>>>;

/** 机器详情、客户详情里的维修记录（客户全公司共享：看不了的门店只给摘要，没有链接） */
export async function listRepairHistory(user: CurrentUser, where: { deviceId?: number; customerId?: number }) {
  if (!where.deviceId && !where.customerId) return [];
  const rows = await prisma.repairOrder.findMany({
    where: where.deviceId ? { deviceId: where.deviceId } : { customerId: where.customerId },
    orderBy: { id: "desc" },
    take: 30,
    include: { store: { select: { id: true, code: true, name: true, regionId: true } } },
  });
  return rows.map((r) => ({
    key: r.id,
    id: canAccessStoreSafe(user, r.store) ? r.id : null,
    orderNo: r.orderNo,
    createdAt: r.createdAt,
    store: `${r.store.code} ${r.store.name}`,
    modelName: r.modelName,
    fault: FAULT_LABELS[r.faultCategory],
    status: r.status,
    payer: r.payer,
    chargeFen: r.chargeFen,
  }));
}

export type RepairHistoryRow = Awaited<ReturnType<typeof listRepairHistory>>[number];

