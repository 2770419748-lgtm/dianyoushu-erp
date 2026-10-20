import "server-only";
import { lockStoreDay } from "./guard";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { maskPhone } from "@/lib/sales-labels";
import { canCloseDay } from "@/server/auth/permissions";
import { assertStoreAccess, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { nextDocNo, todayBizDate } from "@/server/stock/doc-no";
import { buildCloseLines, checkClose, DAILY_CLOSE_METHODS, emptyAmounts, orderMismatchFen, summarizeByMethod, type MethodAmounts } from "./summary";

// 收银日结（口径第 5 节）：按门店、按营业日、按支付方式汇总收款（退款记负），和订单逐笔比对；
// 店长录实收，差异标红；确认后当日销售单、退货单锁定（不能作废），当天也不能再开单退货；总部可以撤销日结。

export class DailyCloseError extends Error {}

type Tx = Prisma.TransactionClient;

/** "2026-10-17" → 存 @db.Date 用的日期 */
export function parseBizDate(text: unknown): Date {
  const s = typeof text === "string" ? text.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new DailyCloseError("日期格式要 YYYY-MM-DD");
  const d = new Date(`${s}T00:00:00.000Z`);
  // 2026-02-31 这种 JS 会悄悄变成 03-03，转回去对不上就是不存在的日期
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new DailyCloseError("没有这一天");
  return d;
}

/** 日结只能做今天和以前的（北京时间）；给未来某天确认了，到那天这家店就开不了单 */
function assertNotFuture(bizDate: Date) {
  if (bizDate.getTime() > todayBizDate().getTime()) throw new DailyCloseError("不能给还没到的日子做日结");
}

async function loadStore(user: CurrentUser, storeId: number) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, code: true, name: true, regionId: true } });
  if (!store) throw new DailyCloseError("门店不存在");
  assertStoreAccess(user, store);
  return store;
}


async function loadDay(tx: Tx | typeof prisma, storeId: number, bizDate: Date) {
  // 依次查，不用 Promise.all：在事务里时 tx 只有一条连接，并发发查询 pg 会报弃用警告
  const orders = await tx.salesOrder.findMany({
      where: { storeId, bizDate },
      orderBy: { id: "asc" },
      include: {
        payments: { select: { method: true, amountFen: true } },
        customer: { select: { name: true, phone: true } },
        salesperson: { select: { name: true } },
      },
    });
  const returns = await tx.returnOrder.findMany({
      where: { storeId, bizDate },
      orderBy: { id: "asc" },
      include: { payments: { select: { method: true, amountFen: true } }, salesOrder: { select: { orderNo: true } }, handledBy: { select: { name: true } } },
    });
  // 维修取机结算的收款也算在取机那天（口径第 13 节）
  const repairs = await tx.repairOrder.findMany({
      where: { storeId, bizDate, status: "CLOSED" },
      orderBy: { id: "asc" },
      include: { payments: { select: { method: true, amountFen: true } }, customer: { select: { name: true, phone: true } }, closedBy: { select: { name: true } } },
    });
  const close = await tx.dailyClose.findUnique({ where: { storeId_bizDate: { storeId, bizDate } }, include: { lines: true, confirmedBy: { select: { name: true } } } });
  const completed = orders.filter((o) => o.status === "COMPLETED");
  const system = summarizeByMethod([...completed.flatMap((o) => o.payments), ...returns.flatMap((r) => r.payments), ...repairs.flatMap((r) => r.payments)]);
  return { orders, completed, returns, repairs, close, system };
}

// ---------- 查询 ----------

export async function getDailyCloseView(user: CurrentUser, storeId: number, bizDate: Date) {
  const store = await loadStore(user, storeId);
  const day = await loadDay(prisma, storeId, bizDate);
  const saved: Partial<Record<PaymentMethod, number | null>> = {};
  for (const line of day.close?.lines ?? []) saved[line.method] = line.actualFen;
  const lines = buildCloseLines(day.system, saved);

  const orders = day.orders.map((o) => {
    const mismatch = o.status === "COMPLETED" ? orderMismatchFen(o.totalFen, o.payments) : 0;
    return {
      id: o.id,
      orderNo: o.orderNo,
      status: o.status,
      totalFen: o.totalFen,
      payments: o.payments,
      mismatchFen: mismatch,
      customer: o.customer ? `${o.customer.name} ${maskPhone(o.customer.phone)}` : "散客",
      salesperson: o.salesperson.name,
      createdAt: o.createdAt,
    };
  });
  const mismatched = orders.filter((o) => o.mismatchFen !== 0).length;

  return {
    store,
    bizDate,
    close: day.close ? { id: day.close.id, closeNo: day.close.closeNo, status: day.close.status, confirmedBy: day.close.confirmedBy?.name ?? null, confirmedAt: day.close.confirmedAt, note: day.close.note } : null,
    lines,
    check: checkClose(lines, mismatched),
    orders,
    returns: day.returns.map((r) => ({ id: r.id, orderNo: r.orderNo, salesOrderNo: r.salesOrder.orderNo, refundFen: r.refundFen, payments: r.payments, handledBy: r.handledBy.name, createdAt: r.createdAt })),
    repairs: day.repairs.map((r) => ({ id: r.id, orderNo: r.orderNo, chargeFen: r.chargeFen, payments: r.payments, customer: `${r.customer.name} ${maskPhone(r.customer.phone)}`, closedBy: r.closedBy?.name ?? "-", closedAt: r.closedAt })),
    totals: {
      orderCount: day.completed.length,
      voidedCount: orders.length - day.completed.length,
      salesFen: day.completed.reduce((s, o) => s + o.totalFen, 0),
      refundFen: day.returns.reduce((s, r) => s + r.refundFen, 0),
      repairFen: day.repairs.reduce((s, r) => s + r.chargeFen, 0),
      systemFen: DAILY_CLOSE_METHODS.reduce((s, m) => s + day.system[m], 0),
    },
  };
}

export type DailyCloseView = Awaited<ReturnType<typeof getDailyCloseView>>;

// ---------- 保存 / 确认 / 撤销 ----------

function parseActuals(input: unknown): Partial<Record<PaymentMethod, number | null>> {
  const out: Partial<Record<PaymentMethod, number | null>> = {};
  if (typeof input !== "object" || input === null) return out;
  for (const method of DAILY_CLOSE_METHODS) {
    const raw = (input as Record<string, unknown>)[method];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new DailyCloseError("实收金额不对");
    out[method] = n;
  }
  return out;
}

async function upsertClose(tx: Tx, user: CurrentUser, storeId: number, bizDate: Date, actuals: Partial<Record<PaymentMethod, number | null>>, note: string | null, system: MethodAmounts) {
  const existing = await tx.dailyClose.findUnique({ where: { storeId_bizDate: { storeId, bizDate } } });
  if (existing?.status === "CONFIRMED") throw new DailyCloseError("这一天已经确认过了");
  const close = existing ?? (await tx.dailyClose.create({ data: { closeNo: await nextDocNo(tx, "DC"), storeId, bizDate } }));
  const lines = buildCloseLines(system, actuals);
  for (const line of lines) {
    await tx.dailyCloseLine.upsert({
      where: { dailyCloseId_method: { dailyCloseId: close.id, method: line.method } },
      update: { systemFen: line.systemFen, actualFen: line.actualFen, diffFen: line.diffFen },
      create: { dailyCloseId: close.id, method: line.method, systemFen: line.systemFen, actualFen: line.actualFen, diffFen: line.diffFen },
    });
  }
  if (note !== null || existing?.note) await tx.dailyClose.update({ where: { id: close.id }, data: { note } });
  return { close, lines };
}

export interface CloseInput {
  storeId: unknown;
  bizDate: unknown;
  actuals: unknown; // { CASH: 分, WECHAT: 分, ... }
  note?: unknown;
}

function parseInput(user: CurrentUser, input: CloseInput) {
  if (!canCloseDay(user.role)) throw new DailyCloseError("只有店长和总部能做日结");
  const storeId = Number(input.storeId);
  if (!Number.isInteger(storeId) || storeId <= 0) throw new DailyCloseError("请选门店");
  return {
    storeId,
    bizDate: parseBizDate(input.bizDate),
    actuals: parseActuals(input.actuals),
    note: typeof input.note === "string" ? input.note.trim().slice(0, 200) || null : null,
  };
}

/** 先存实收、不确认（中途保存） */
export async function saveDailyCloseTx(tx: Tx, user: CurrentUser, input: CloseInput) {
  const data = parseInput(user, input);
  assertNotFuture(data.bizDate);
  await loadStore(user, data.storeId);
  await lockStoreDay(tx, data.storeId, data.bizDate);
  const day = await loadDay(tx, data.storeId, data.bizDate);
  await upsertClose(tx, user, data.storeId, data.bizDate, data.actuals, data.note, day.system);
}

export async function confirmDailyCloseTx(tx: Tx, user: CurrentUser, input: CloseInput) {
  const data = parseInput(user, input);
  assertNotFuture(data.bizDate);
  await loadStore(user, data.storeId);
  // 和开单、作废、退货排队：拿到锁之后读到的当天单据就是最终的，算完账、锁单之前不会再有变化
  await lockStoreDay(tx, data.storeId, data.bizDate);
  const day = await loadDay(tx, data.storeId, data.bizDate);
  const mismatched = day.completed.filter((o) => orderMismatchFen(o.totalFen, o.payments) !== 0).length;
  const { close, lines } = await upsertClose(tx, user, data.storeId, data.bizDate, data.actuals, data.note, day.system);
  const check = checkClose(lines, mismatched);
  if (check.missing.length > 0) throw new DailyCloseError(`还有 ${check.missing.length} 种收款方式没录实收`);
  if (check.mismatchedOrders > 0) throw new DailyCloseError(`有 ${check.mismatchedOrders} 张单收款合计和应收对不上，先处理`);
  if (check.diffs.length > 0 && !data.note) throw new DailyCloseError("有差异要写备注说明原因再确认");

  await tx.dailyClose.update({ where: { id: close.id }, data: { status: "CONFIRMED", confirmedById: user.id, confirmedAt: new Date() } });
  await tx.salesOrder.updateMany({ where: { storeId: data.storeId, bizDate: data.bizDate, status: "COMPLETED" }, data: { dailyCloseId: close.id } });
  await tx.returnOrder.updateMany({ where: { storeId: data.storeId, bizDate: data.bizDate }, data: { dailyCloseId: close.id } });
  await tx.repairOrder.updateMany({ where: { storeId: data.storeId, bizDate: data.bizDate, status: "CLOSED" }, data: { dailyCloseId: close.id } });
  await writeAudit(
    { userId: user.id, action: "daily_close.confirm", entity: "daily_close", entityId: close.id, detail: { closeNo: close.closeNo, diffs: check.diffs.length, orders: day.completed.length } },
    tx,
  );
  return { closeNo: close.closeNo, diffs: check.diffs };
}

/** 撤销日结（只有总部）：回到未确认，当天单据解锁 */
export async function reopenDailyCloseTx(tx: Tx, user: CurrentUser, storeId: number, bizDate: Date, reason: unknown) {
  if (user.role !== "HQ") throw new DailyCloseError("只有总部能撤销日结");
  await lockStoreDay(tx, storeId, bizDate);
  const close = await tx.dailyClose.findUnique({ where: { storeId_bizDate: { storeId, bizDate } } });
  if (!close || close.status !== "CONFIRMED") throw new DailyCloseError("这一天还没确认，不用撤销");
  const text = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (!text) throw new DailyCloseError("撤销要写原因");
  await tx.dailyClose.update({ where: { id: close.id }, data: { status: "PENDING", confirmedById: null, confirmedAt: null, note: `${close.note ? `${close.note}；` : ""}撤销：${text}` } });
  await tx.salesOrder.updateMany({ where: { dailyCloseId: close.id }, data: { dailyCloseId: null } });
  await tx.returnOrder.updateMany({ where: { dailyCloseId: close.id }, data: { dailyCloseId: null } });
  await tx.repairOrder.updateMany({ where: { dailyCloseId: close.id }, data: { dailyCloseId: null } });
  await writeAudit({ userId: user.id, action: "daily_close.reopen", entity: "daily_close", entityId: close.id, detail: { reason: text } }, tx);
}

export async function saveDailyClose(user: CurrentUser, input: CloseInput) {
  return prisma.$transaction((tx) => saveDailyCloseTx(tx, user, input));
}

export async function confirmDailyClose(user: CurrentUser, input: CloseInput) {
  return prisma.$transaction((tx) => confirmDailyCloseTx(tx, user, input));
}

export async function reopenDailyClose(user: CurrentUser, storeId: number, bizDate: Date, reason: unknown) {
  return prisma.$transaction((tx) => reopenDailyCloseTx(tx, user, storeId, bizDate, reason));
}

// ---------- 收银日报表 ----------

export interface CashierReportQuery {
  from: Date;
  to: Date;
  storeId?: number;
}

/** 按门店 × 营业日汇总各支付方式（收款 − 退款），带日结状态 */
export async function cashierReport(user: CurrentUser, query: CashierReportQuery) {
  const scope = storeScopeWhere(user);
  const storeFilter = query.storeId ? { storeId: query.storeId } : {};
  const dateFilter = { bizDate: { gte: query.from, lte: query.to } };
  const [sales, returns, closes] = await Promise.all([
    prisma.payment.findMany({
      where: { salesOrder: { AND: [scope, storeFilter, dateFilter, { status: "COMPLETED" }] } },
      select: { method: true, amountFen: true, salesOrder: { select: { storeId: true, bizDate: true } } },
    }),
    prisma.payment.findMany({
      where: { returnOrder: { AND: [scope, storeFilter, dateFilter] } },
      select: { method: true, amountFen: true, returnOrder: { select: { storeId: true, bizDate: true } } },
    }),
    prisma.dailyClose.findMany({ where: { AND: [scope, storeFilter, dateFilter] }, select: { storeId: true, bizDate: true, status: true, lines: { select: { diffFen: true } } } }),
  ]);
  // 维修取机的收款（口径第 13 节）
  const repairs = await prisma.payment.findMany({
    where: { repairOrder: { AND: [scope, storeFilter, dateFilter, { status: "CLOSED" }] } },
    select: { method: true, amountFen: true, repairOrder: { select: { storeId: true, bizDate: true } } },
  });
  const stores = await prisma.store.findMany({ where: query.storeId ? { id: query.storeId } : {}, select: { id: true, code: true, name: true } });
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const rows = new Map<string, { storeId: number; bizDate: Date; amounts: MethodAmounts; orderPayments: number }>();
  const keyOf = (storeId: number, d: Date) => `${storeId}|${d.toISOString().slice(0, 10)}`;
  const add = (storeId: number, bizDate: Date, method: PaymentMethod, amountFen: number) => {
    const key = keyOf(storeId, bizDate);
    const row = rows.get(key) ?? { storeId, bizDate, amounts: emptyAmounts(), orderPayments: 0 };
    row.amounts[method] += amountFen;
    row.orderPayments++;
    rows.set(key, row);
  };
  for (const p of sales) add(p.salesOrder!.storeId, p.salesOrder!.bizDate, p.method, p.amountFen);
  for (const p of returns) add(p.returnOrder!.storeId, p.returnOrder!.bizDate, p.method, p.amountFen);
  for (const p of repairs) add(p.repairOrder!.storeId, p.repairOrder!.bizDate!, p.method, p.amountFen);
  const closeByKey = new Map(closes.map((c) => [keyOf(c.storeId, c.bizDate), c]));

  return Array.from(rows.values())
    .map((r) => {
      const close = closeByKey.get(keyOf(r.storeId, r.bizDate));
      const store = storeById.get(r.storeId);
      return {
        key: keyOf(r.storeId, r.bizDate),
        storeId: r.storeId,
        storeLabel: store ? `${store.code} ${store.name}` : String(r.storeId),
        bizDate: r.bizDate.toISOString().slice(0, 10),
        amounts: r.amounts,
        totalFen: DAILY_CLOSE_METHODS.reduce((s, m) => s + r.amounts[m], 0),
        cashFen: DAILY_CLOSE_METHODS.filter((m) => m !== "TRADE_IN").reduce((s, m) => s + r.amounts[m], 0),
        closeStatus: close?.status ?? null,
        hasDiff: close ? close.lines.some((l) => (l.diffFen ?? 0) !== 0) : false,
      };
    })
    .sort((a, b) => (a.bizDate === b.bizDate ? a.storeLabel.localeCompare(b.storeLabel) : b.bizDate.localeCompare(a.bizDate)));
}

export type CashierReportRow = Awaited<ReturnType<typeof cashierReport>>[number];
