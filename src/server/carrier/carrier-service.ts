import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { Carrier, CarrierBizStatus, CarrierBizType } from "@/generated/prisma/enums";
import {
  CARRIER_BIZ_TYPES,
  CARRIER_LABELS,
  CARRIERS,
  isSettleableMonth,
  monthRange,
  parseStatementCsv,
  reconcileStatement,
  StatementParseError,
  type StatementLine,
} from "@/lib/carrier";
import { isValidFen, MAX_AMOUNT_FEN } from "@/lib/limits";
import { maskPhone } from "@/lib/sales-labels";
import { canHandleCarrier, canManageCarrier, canVoidCarrier } from "@/server/auth/permissions";
import { assertStoreAccess, PermissionError, storeScopeWhere } from "@/server/auth/scope";
import { decryptPii, encryptPii, phoneColumns, phoneFingerprint, phoneSearch } from "@/server/pii/crypto";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { lockRow } from "@/server/db-lock";
import { type Db, withTx } from "@/server/db-tx";
import { nextDocNo, todayBizDate } from "@/server/stock/doc-no";

// 运营商业务（口径第 14 节）：门店登记每一笔、确认开通；总部维护佣金政策、按月导入运营商结算单对账。
// 运营商不开放接口：真用时“导入渠道系统导出的 CSV”；演示里有“同步运营商状态”和“生成模拟结算单”两个模拟器（只在演示模式能用）。

export class CarrierError extends Error {}

type Tx = Prisma.TransactionClient;

function isDemo(): boolean {
  return process.env.DEMO_MODE !== "0";
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function wrapAccess(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (error instanceof PermissionError) throw new CarrierError(error.message);
    throw error;
  }
}

function assertHq(user: CurrentUser) {
  if (!canManageCarrier(user.role)) throw new CarrierError("运营商佣金政策和结算对账只有总部能做");
}

// ---------- 佣金政策 ----------

export async function listCommissionRules() {
  return prisma.carrierCommissionRule.findMany({ orderBy: [{ carrier: "asc" }, { bizType: "asc" }] });
}

export async function saveCommissionRule(user: CurrentUser, input: { carrier: unknown; bizType: unknown; commissionFen: unknown; clawbackMonths: unknown; isActive?: unknown; note?: unknown }) {
  assertHq(user);
  const carrier = input.carrier as Carrier;
  const bizType = input.bizType as CarrierBizType;
  if (!CARRIERS.includes(carrier) || !CARRIER_BIZ_TYPES.includes(bizType)) throw new CarrierError("运营商或业务类型不对");
  const commissionFen = Number(input.commissionFen);
  if (!isValidFen(commissionFen)) throw new CarrierError(`金额不对：佣金要在 0 到 ${MAX_AMOUNT_FEN / 1_000_000} 万元之间`);
  const clawbackMonths = Number(input.clawbackMonths);
  if (!Number.isInteger(clawbackMonths) || clawbackMonths < 0 || clawbackMonths > 24) throw new CarrierError("返销期填 0 到 24 个月");
  const data = { commissionFen, clawbackMonths, isActive: input.isActive !== false, note: text(input.note, 100) || null };
  const rule = await prisma.carrierCommissionRule.upsert({ where: { carrier_bizType: { carrier, bizType } }, create: { carrier, bizType, ...data }, update: data });
  await writeAudit({ userId: user.id, action: "carrier.rule.save", entity: "carrier_rule", entityId: rule.id, detail: { carrier, bizType, ...data } });
  return rule;
}

// ---------- 业务单 ----------

export interface CarrierBusinessInput {
  storeId: unknown;
  customerId?: unknown;
  carrier: unknown;
  bizType: unknown;
  phone: unknown;
  packageName: unknown;
  monthlyFeeFen?: unknown;
  carrierOrderNo?: unknown;
  salesOrderNo?: unknown; // 合约机：本店卖机器的销售单号
  note?: unknown;
}

const PHONE = /^1\d{10}$/;
const CARRIER_ORDER_NO = /^[A-Za-z0-9-]{4,40}$/;

/** 受理单号：格式对、同一运营商没作废的业务里不重复（对账按它对，重复了只能对上一笔）；数据库还有部分唯一索引兜底 */
async function checkCarrierOrderNo(tx: Tx, carrier: Carrier, carrierOrderNo: string | null, exceptId?: number) {
  if (!carrierOrderNo) return;
  if (!CARRIER_ORDER_NO.test(carrierOrderNo)) throw new CarrierError("受理单号只能是字母、数字和横线（4～40 位）");
  const dup = await tx.carrierBusiness.findFirst({ where: { carrier, carrierOrderNo, status: { not: "VOIDED" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { orderNo: true } });
  if (dup) throw new CarrierError(`${CARRIER_LABELS[carrier]}的受理单号 ${carrierOrderNo} 已经登记在 ${dup.orderNo} 上了`);
}

export async function registerBusinessTx(tx: Tx, user: CurrentUser, input: CarrierBusinessInput) {
  if (!canHandleCarrier(user.role)) throw new CarrierError("你的角色不能登记运营商业务");
  const storeId = Number(input.storeId);
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true, isActive: true } });
  if (!store || !store.isActive) throw new CarrierError("门店不存在或已停用");
  wrapAccess(() => assertStoreAccess(user, store));
  const carrier = input.carrier as Carrier;
  if (!CARRIERS.includes(carrier)) throw new CarrierError("请选运营商");
  const bizType = input.bizType as CarrierBizType;
  if (!CARRIER_BIZ_TYPES.includes(bizType)) throw new CarrierError("请选业务类型");
  const phone = text(input.phone, 11);
  if (!PHONE.test(phone)) throw new CarrierError("号码要 11 位手机号（宽带填客户的联系手机）");
  const packageName = text(input.packageName, 60);
  if (!packageName) throw new CarrierError("写一下套餐名");
  const monthlyFeeFen = input.monthlyFeeFen === undefined || input.monthlyFeeFen === null || input.monthlyFeeFen === "" ? null : Number(input.monthlyFeeFen);
  if (monthlyFeeFen !== null && !isValidFen(monthlyFeeFen)) throw new CarrierError("月租金额不对");
  const carrierOrderNo = text(input.carrierOrderNo, 40) || null;
  await checkCarrierOrderNo(tx, carrier, carrierOrderNo);

  let customerId: number | null = null;
  if (input.customerId) {
    customerId = Number(input.customerId);
    if (!(await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) throw new CarrierError("客户不存在");
  }
  let salesOrderId: number | null = null;
  const salesOrderNo = text(input.salesOrderNo, 30);
  if (salesOrderNo) {
    const order = await tx.salesOrder.findUnique({ where: { orderNo: salesOrderNo }, select: { id: true, storeId: true, status: true, customerId: true } });
    if (!order || order.storeId !== storeId) throw new CarrierError(`本店没有销售单 ${salesOrderNo}`);
    if (order.status !== "COMPLETED") throw new CarrierError("关联的销售单已作废");
    salesOrderId = order.id;
    customerId ??= order.customerId;
  }
  const rule = await tx.carrierCommissionRule.findUnique({ where: { carrier_bizType: { carrier, bizType } } });
  if (!rule || !rule.isActive) throw new CarrierError(`总部还没配“${CARRIER_LABELS[carrier]}”这项业务的佣金政策，先找总部配上再登记`);

  const orderNo = await nextDocNo(tx, "YY");
  const row = await tx.carrierBusiness.create({
    data: {
      orderNo,
      storeId,
      handledById: user.id,
      customerId,
      carrier,
      bizType,
      ...phoneColumns(phone),
      packageName,
      monthlyFeeFen,
      carrierOrderNo,
      salesOrderId,
      bizDate: todayBizDate(),
      expectedCommissionFen: rule.commissionFen,
      clawbackMonths: rule.clawbackMonths,
      note: text(input.note, 200) || null,
    },
  });
  await writeAudit({ userId: user.id, action: "carrier.register", entity: "carrier_business", entityId: row.id, detail: { orderNo, carrier, bizType, expectedCommissionFen: rule.commissionFen } }, tx);
  return { id: row.id, orderNo };
}

async function lockBusiness(tx: Tx, user: CurrentUser, id: number) {
  if (!(await lockRow(tx, "carrier_business", id))) throw new CarrierError("业务单不存在");
  const row = await tx.carrierBusiness.findUniqueOrThrow({ where: { id }, include: { store: { select: { id: true, regionId: true } } } });
  wrapAccess(() => assertStoreAccess(user, row.store));
  return row;
}

/** 店员在运营商系统看到办成了 / 没办成，回来确认（真用时就是这一步） */
export async function confirmBusinessTx(tx: Tx, user: CurrentUser, id: number, input: { activated: boolean; carrierOrderNo?: unknown; reason?: unknown }) {
  if (!canHandleCarrier(user.role)) throw new CarrierError("你的角色不能操作运营商业务");
  const row = await lockBusiness(tx, user, id);
  if (user.role === "STAFF" && row.handledById !== user.id) throw new CarrierError("店员只能确认自己经办的业务，别人的找店长");
  if (row.status !== "SUBMITTED") throw new CarrierError("已登记的业务才能确认开通或失败");
  const carrierOrderNo = text(input.carrierOrderNo, 40) || row.carrierOrderNo;
  if (input.activated && carrierOrderNo !== row.carrierOrderNo) await checkCarrierOrderNo(tx, row.carrier, carrierOrderNo, id);
  if (input.activated) {
    await tx.carrierBusiness.update({ where: { id }, data: { status: "ACTIVATED", activatedAt: new Date(), carrierOrderNo } });
  } else {
    const reason = text(input.reason, 100);
    if (!reason) throw new CarrierError("写一下没办成的原因");
    await tx.carrierBusiness.update({ where: { id }, data: { status: "FAILED", failedReason: reason } });
  }
  await writeAudit({ userId: user.id, action: input.activated ? "carrier.activate" : "carrier.fail", entity: "carrier_business", entityId: id }, tx);
}

export async function voidBusinessTx(tx: Tx, user: CurrentUser, id: number, reason: unknown) {
  if (!canVoidCarrier(user.role)) throw new CarrierError("只有店长和总部能作废运营商业务单");
  const row = await lockBusiness(tx, user, id);
  if (row.status === "SETTLED" || row.status === "CLAWED_BACK" || row.status === "VOIDED") throw new CarrierError("已结算、已返销、已作废的单不能作废");
  const voidReason = text(reason, 200);
  if (!voidReason) throw new CarrierError("写一下作废原因");
  await tx.carrierBusiness.update({ where: { id }, data: { status: "VOIDED", voidedAt: new Date(), voidedById: user.id, voidReason } });
  await writeAudit({ userId: user.id, action: "carrier.void", entity: "carrier_business", entityId: id, detail: { reason: voidReason } }, tx);
}

const FAIL_REASONS = ["运营商审核未通过：实名信息不符", "号码已被占用", "宽带地址不在覆盖范围"];

/**
 * 模拟器：从运营商系统同步办理状态（演示用）。已登记的大部分变已开通（补上受理单号），少数办理失败。
 * 真用时运营商不开放接口，店员在渠道系统看到结果后回来手动确认。
 */
export async function syncSimulatedStatus(user: CurrentUser, options: { db?: Db; random?: () => number } = {}) {
  if (!isDemo()) throw new CarrierError("真用时运营商系统没有接口，请店员手动确认开通");
  if (!canHandleCarrier(user.role)) throw new CarrierError("你的角色不能操作运营商业务");
  const db = options.db ?? prisma;
  const random = options.random ?? Math.random;
  return withTx(db, async (tx) => {
    const rows = await tx.carrierBusiness.findMany({ where: { AND: [storeScopeWhere(user), user.role === "STAFF" ? { handledById: user.id } : {}, { status: "SUBMITTED" }] }, select: { id: true, carrier: true, carrierOrderNo: true } });
    let activated = 0;
    let failed = 0;
    for (const r of rows) {
      if (random() < 0.92) {
        // 条件写入：读出来之后被店员手动确认、作废了的不动
        const carrierOrderNo = r.carrierOrderNo ?? `${r.carrier}${Date.now().toString().slice(-8)}${String(r.id).padStart(6, "0")}`;
        activated += (await tx.carrierBusiness.updateMany({ where: { id: r.id, status: "SUBMITTED" }, data: { status: "ACTIVATED", activatedAt: new Date(), carrierOrderNo } })).count;
      } else {
        failed += (await tx.carrierBusiness.updateMany({ where: { id: r.id, status: "SUBMITTED" }, data: { status: "FAILED", failedReason: FAIL_REASONS[Math.floor(random() * FAIL_REASONS.length)]! } })).count;
      }
    }
    await writeAudit({ userId: user.id, action: "carrier.sync_simulated", detail: { activated, failed } }, tx);
    return { activated, failed };
  });
}

export const carrierActions = {
  register: (user: CurrentUser, input: CarrierBusinessInput) => withTx(prisma, (tx) => registerBusinessTx(tx, user, input)),
  confirm: (user: CurrentUser, id: number, input: { activated: boolean; carrierOrderNo?: unknown; reason?: unknown }) => withTx(prisma, (tx) => confirmBusinessTx(tx, user, id, input)),
  void: (user: CurrentUser, id: number, reason: unknown) => withTx(prisma, (tx) => voidBusinessTx(tx, user, id, reason)),
};

// ---------- 结算对账 ----------

/** 同一个运营商的结算单一次只对一张：两个月份同时导入时，后一张要等前一张对完再读候选，不会把同一笔结算两次 */
const CARRIER_SETTLE_LOCK_NS = -75;

async function importLinesTx(tx: Tx, user: CurrentUser, carrier: Carrier, month: string, lines: StatementLine[], source: "FILE" | "SIMULATED") {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CARRIER_SETTLE_LOCK_NS}::int, hashtext(${carrier}::text))`;
  if (await tx.carrierSettlement.findUnique({ where: { carrier_month: { carrier, month } } })) throw new CarrierError(`${CARRIER_LABELS[carrier]} ${month} 已经对过账了，一个月只能对一次`);
  const { from, to } = monthRange(month);
  // 候选：这个运营商已开通、已结算的业务（返销可能是以前月份的）
  const candidates = await tx.carrierBusiness.findMany({
    where: { carrier, status: { in: ["ACTIVATED", "SETTLED"] }, bizDate: { lt: to } },
    select: { id: true, carrierOrderNo: true, phoneFp: true, bizType: true, expectedCommissionFen: true, status: true, bizDate: true },
  });
  // 号码加密存（口径第 20 节）：按号码对账时两边都用指纹比；结算单上的原号码加密后存进结算明细
  const plainPhones = lines.map((l) => (l.phone ? l.phone.replace(/\s/g, "") : null));
  const result = reconcileStatement(
    lines.map((l, i) => ({ ...l, phone: plainPhones[i] ? phoneFingerprint(plainPhones[i]!) : null })),
    candidates.map(({ phoneFp, ...c }) => ({ ...c, phone: phoneFp, inMonth: c.bizDate >= from && c.bizDate < to })),
  );
  const settlementNo = await nextDocNo(tx, "JS");
  const settlement = await tx.carrierSettlement.create({
    data: {
      settlementNo,
      carrier,
      month,
      source,
      importedById: user.id,
      lineCount: lines.length,
      matchedCount: result.lines.filter((l) => l.result === "MATCHED").length,
      diffCount: result.lines.filter((l) => l.result === "DIFF").length,
      unmatchedCount: result.lines.filter((l) => l.result === "UNMATCHED").length,
      missingCount: result.missing.length,
      totalCommissionFen: lines.reduce((s, l) => s + l.commissionFen, 0),
      totalClawbackFen: lines.reduce((s, l) => s + l.clawbackFen, 0),
    },
  });
  // reconcileStatement 按输入顺序一行出一行，按下标取回原号码
  await tx.carrierSettlementLine.createMany({ data: result.lines.map((l, i) => ({ settlementId: settlement.id, carrierOrderNo: l.carrierOrderNo, phoneEnc: plainPhones[i] ? encryptPii(plainPhones[i]!) : null, phoneMasked: plainPhones[i] ? maskPhone(plainPhones[i]!) : null, bizType: l.bizType, commissionFen: l.commissionFen, clawbackFen: l.clawbackFen, businessId: l.businessId, result: l.result })) });
  // 条件写入兜底：读候选之后被别处改过状态的，整张单不落（加了锁正常碰不到）
  for (const s of result.settle) {
    const done = await tx.carrierBusiness.updateMany({ where: { id: s.id, status: "ACTIVATED" }, data: { status: "SETTLED", settledFen: s.settledFen, settlementId: settlement.id } });
    if (done.count === 0) throw new CarrierError("有业务刚被别的结算单对过了，刷新后重新导入");
  }
  for (const c of result.clawback) {
    const done = await tx.carrierBusiness.updateMany({ where: { id: c.id, status: { in: ["ACTIVATED", "SETTLED"] } }, data: { status: "CLAWED_BACK", clawbackFen: c.clawbackFen } });
    if (done.count === 0) throw new CarrierError("有业务刚被别的结算单返销过了，刷新后重新导入");
  }
  await writeAudit({ userId: user.id, action: "carrier.settlement.import", entity: "carrier_settlement", entityId: settlement.id, detail: { settlementNo, carrier, month, source, lines: lines.length, missing: result.missing.length } }, tx);
  return { id: settlement.id, settlementNo };
}

function parseCarrierMonth(carrier: unknown, month: unknown): { carrier: Carrier; month: string } {
  if (!CARRIERS.includes(carrier as Carrier)) throw new CarrierError("请选运营商");
  const m = typeof month === "string" ? month : "";
  if (!isSettleableMonth(m, todayBizDate())) throw new CarrierError("结算月份要是已经过完的月份（月底后运营商才出结算单），格式如 2026-09");
  return { carrier: carrier as Carrier, month: m };
}

/** 导入运营商渠道系统导出的结算单 CSV（真用的路子） */
export async function importSettlementCsv(user: CurrentUser, input: { carrier: unknown; month: unknown; csv: unknown }, db: Db = prisma) {
  assertHq(user);
  const { carrier, month } = parseCarrierMonth(input.carrier, input.month);
  let lines: StatementLine[];
  try {
    lines = parseStatementCsv(typeof input.csv === "string" ? input.csv : "");
  } catch (error) {
    if (error instanceof StatementParseError) throw new CarrierError(error.message);
    throw error;
  }
  if (lines.length > 5000) throw new CarrierError("一次最多导入 5000 行");
  return withTx(db, (tx) => importLinesTx(tx, user, carrier, month, lines, "FILE"));
}

/**
 * 模拟器：按这个月已开通的业务生成一张结算单再对账（演示用）。大部分照预计佣金给，少数少给 10 元，
 * 少数漏给；以前已结算的少数被返销；再加一行运营商有、我们没登记的。
 */
export async function generateSimulatedSettlement(user: CurrentUser, input: { carrier: unknown; month: unknown }, options: { db?: Db; random?: () => number } = {}) {
  if (!isDemo()) throw new CarrierError("模拟结算单只能在演示里用；真用请导入运营商渠道系统导出的结算单");
  assertHq(user);
  const { carrier, month } = parseCarrierMonth(input.carrier, input.month);
  const db = options.db ?? prisma;
  const random = options.random ?? Math.random;
  const { from, to } = monthRange(month);
  return withTx(db, async (tx) => {
    // 模拟运营商那边的表格：号码是明文（在服务端解开，不出这个函数）
    const active = (await tx.carrierBusiness.findMany({ where: { carrier, status: "ACTIVATED", bizDate: { gte: from, lt: to } }, select: { carrierOrderNo: true, phoneEnc: true, bizType: true, expectedCommissionFen: true } })).map(({ phoneEnc, ...b }) => ({ ...b, phone: decryptPii(phoneEnc) }));
    const settledBefore = (await tx.carrierBusiness.findMany({ where: { carrier, status: "SETTLED", bizDate: { lt: from } }, select: { carrierOrderNo: true, phoneEnc: true, bizType: true, settledFen: true } })).map(({ phoneEnc, ...b }) => ({ ...b, phone: decryptPii(phoneEnc) }));
    const lines: StatementLine[] = [];
    for (const b of active) {
      const r = random();
      if (r < 0.03) continue; // 运营商漏给
      lines.push({ carrierOrderNo: b.carrierOrderNo, phone: b.phone, bizType: b.bizType, commissionFen: r < 0.07 ? Math.max(0, b.expectedCommissionFen - 1000) : b.expectedCommissionFen, clawbackFen: 0 });
    }
    for (const b of settledBefore) if (random() < 0.03) lines.push({ carrierOrderNo: b.carrierOrderNo, phone: b.phone, bizType: b.bizType, commissionFen: 0, clawbackFen: b.settledFen ?? 0 });
    lines.push({ carrierOrderNo: `${carrier}UNKNOWN${month.replace("-", "")}`, phone: "13900000000", bizType: "NEW_LINE", commissionFen: 5000, clawbackFen: 0 });
    return importLinesTx(tx, user, carrier, month, lines, "SIMULATED");
  });
}

// ---------- 查询 ----------

export const CARRIER_PAGE_SIZE = 20;

export interface CarrierQuery {
  status?: CarrierBizStatus;
  carrier?: Carrier;
  bizType?: CarrierBizType;
  month?: string;
  storeId?: number;
  q?: string;
  page?: number;
}

/** 业务明细：店员只看自己经办的，店长本店，区域经理辖区（只读），总部全部 */
function businessWhere(user: CurrentUser, query: CarrierQuery): Prisma.CarrierBusinessWhereInput {
  const q = (query.q ?? "").trim();
  const range = query.month && /^\d{4}-\d{2}$/.test(query.month) ? monthRange(query.month) : null;
  return {
    AND: [
      storeScopeWhere(user),
      user.role === "STAFF" ? { handledById: user.id } : {},
      query.storeId ? { storeId: query.storeId } : {},
      query.status ? { status: query.status } : {},
      query.carrier ? { carrier: query.carrier } : {},
      query.bizType ? { bizType: query.bizType } : {},
      range ? { bizDate: { gte: range.from, lt: range.to } } : {},
      // 号码加密存（口径第 20 节）：只能整号或尾号 4 位搜
      q ? { OR: [{ orderNo: { contains: q, mode: "insensitive" } }, { carrierOrderNo: { contains: q } }, ...(phoneSearch(q) ? [phoneSearch(q)!] : [])] } : {},
    ],
  };
}

export async function listBusiness(user: CurrentUser, query: CarrierQuery) {
  const page = clampPage(query.page);
  const where = businessWhere(user, query);
  const [rows, total] = await Promise.all([
    prisma.carrierBusiness.findMany({
      where,
      orderBy: [{ bizDate: "desc" }, { id: "desc" }],
      skip: (page - 1) * CARRIER_PAGE_SIZE,
      take: CARRIER_PAGE_SIZE,
      include: { store: { select: { code: true, name: true } }, handledBy: { select: { name: true } }, customer: { select: { id: true, name: true } }, salesOrder: { select: { id: true, orderNo: true } } },
      omit: { phoneEnc: true, phoneFp: true }, // 密文、指纹不出服务端，页面只用打码号码
    }),
    prisma.carrierBusiness.count({ where }),
  ]);
  return {
    rows,
    total,
    page,
    pageSize: CARRIER_PAGE_SIZE,
    can: { register: canHandleCarrier(user.role), void: canVoidCarrier(user.role), manage: canManageCarrier(user.role), simulate: isDemo() && canHandleCarrier(user.role) },
  };
}

export type CarrierBusinessRow = Awaited<ReturnType<typeof listBusiness>>["rows"][number];

/** 统计：按门店、员工、运营商、业务类型汇总笔数和佣金（作废、失败的只算笔数） */
export async function carrierStats(user: CurrentUser, query: { month?: string; storeId?: number }) {
  const where = businessWhere(user, { month: query.month, storeId: query.storeId });
  const rows = await prisma.carrierBusiness.findMany({
    where,
    select: { status: true, carrier: true, bizType: true, expectedCommissionFen: true, settledFen: true, clawbackFen: true, store: { select: { id: true, code: true, name: true } }, handledBy: { select: { id: true, name: true } } },
  });
  type Agg = { key: string; label: string; count: number; activated: number; failed: number; expectedFen: number; settledFen: number; clawbackFen: number };
  const group = (keyOf: (r: (typeof rows)[number]) => [string, string]) => {
    const map = new Map<string, Agg>();
    for (const r of rows) {
      const [key, label] = keyOf(r);
      const a = map.get(key) ?? { key, label, count: 0, activated: 0, failed: 0, expectedFen: 0, settledFen: 0, clawbackFen: 0 };
      a.count++;
      if (r.status === "FAILED") a.failed++;
      if (r.status !== "SUBMITTED" && r.status !== "FAILED" && r.status !== "VOIDED") {
        a.activated++;
        a.expectedFen += r.expectedCommissionFen;
      }
      a.settledFen += r.settledFen ?? 0;
      a.clawbackFen += r.clawbackFen ?? 0;
      map.set(key, a);
    }
    return Array.from(map.values()).sort((x, y) => y.expectedFen - x.expectedFen);
  };
  return {
    byStore: group((r) => [String(r.store.id), `${r.store.code} ${r.store.name}`]),
    byStaff: group((r) => [String(r.handledBy.id), `${r.handledBy.name}（${r.store.name}）`]),
    byCarrier: group((r) => [r.carrier, CARRIER_LABELS[r.carrier]]),
    byType: group((r) => [r.bizType, r.bizType]),
    total: rows.length,
  };
}

export async function listSettlements(user: CurrentUser) {
  assertHq(user);
  return prisma.carrierSettlement.findMany({ orderBy: [{ month: "desc" }, { carrier: "asc" }], include: { importedBy: { select: { name: true } } } });
}

export async function getSettlement(user: CurrentUser, id: number) {
  assertHq(user);
  const settlement = await prisma.carrierSettlement.findUnique({
    where: { id },
    include: { importedBy: { select: { name: true } }, lines: { orderBy: [{ result: "asc" }, { id: "asc" }], omit: { phoneEnc: true }, include: { business: { select: { id: true, orderNo: true, expectedCommissionFen: true, store: { select: { name: true } } } } } } },
  });
  if (!settlement) return null;
  const { from, to } = monthRange(settlement.month);
  // 我们登记了、这张结算单里没给佣金的
  const missing = await prisma.carrierBusiness.findMany({
    where: { carrier: settlement.carrier, status: "ACTIVATED", bizDate: { gte: from, lt: to } },
    include: { store: { select: { name: true } }, handledBy: { select: { name: true } } },
    omit: { phoneEnc: true, phoneFp: true },
    orderBy: { bizDate: "asc" },
  });
  return { ...settlement, missing };
}

export type CarrierSettlementDetail = NonNullable<Awaited<ReturnType<typeof getSettlement>>>;
