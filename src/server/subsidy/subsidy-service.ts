import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { SubsidyClaimStatus } from "@/generated/prisma/enums";
import { monthRange } from "@/lib/carrier";
import { isValidFen, MAX_AMOUNT_FEN } from "@/lib/limits";
import { maskPhone } from "@/lib/sales-labels";
import {
  applyPlatformResult,
  lineBaseFen,
  normalizeQualificationCode,
  parsePlatformResultCsv,
  planSubsidy,
  simulateVerifyQualification,
  SUBSIDY_RECEIVABLE_STATUSES,
  SUBSIDY_USED_STATUSES,
  SubsidyParseError,
  type PlatformResultLine,
  type SubsidyCandidate,
  type SubsidyPick,
  type SubsidyPolicyRule,
} from "@/lib/subsidy";
import { canManageSubsidy, canSell } from "@/server/auth/permissions";
import { assertStoreAccess, PermissionError, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { lockRow } from "@/server/db-lock";
import { type Db, withTx } from "@/server/db-tx";
import { nextDocNo, todayBizDate } from "@/server/stock/doc-no";
import { isUniqueViolation } from "@/server/db-errors";
import { issuedInvoiceNumber, isReddedOnOrder } from "@/server/invoice/invoice-service";

// 国补（口径第 15 节）：总部配政策；开单时按政策算立减、校验资格，每台补贴的机器生成一张国补单；
// 门店补资料提交审核，总部导入平台的审核 / 到账结果；作废、退货时撤销或标“需退回”。
// 各省平台不对门店系统开放：真用时导入平台导出的结果表格，演示里“平台审核（模拟）”“到账（模拟）”两个按钮只在演示模式能用。

export class SubsidyError extends Error {}

type Tx = Prisma.TransactionClient;

/** 同一个客户同时开两张国补单：按客户排队，保证“每人每类一台”不会被并发绕过 */
const SUBSIDY_CUSTOMER_LOCK_NS = -74;

function isDemo(): boolean {
  return process.env.DEMO_MODE !== "0";
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function assertHq(user: CurrentUser) {
  if (!canManageSubsidy(user.role)) throw new SubsidyError("国补政策、平台结果导入只有总部能做");
}

function wrapAccess(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (error instanceof PermissionError) throw new SubsidyError(error.message);
    throw error;
  }
}

function parseDate(value: unknown, label: string): Date {
  const s = typeof value === "string" ? value.trim() : "";
  const date = new Date(`${s}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(date.getTime())) throw new SubsidyError(`${label}要写成 2026-01-01 这样`);
  // 2026-02-30 这种不存在的日期，Date 会滚到 3 月 2 日：回读不一样就拦下
  if (date.toISOString().slice(0, 10) !== s) throw new SubsidyError(`${label} ${s} 不是一个真实的日期`);
  return date;
}

// ---------- 政策 ----------

/** 大件品类（手机、平板）和它们的政策：没配的品类返回 policy = null */
export async function listPolicies() {
  const [categories, policies] = await Promise.all([
    prisma.category.findMany({ where: { kind: "DEVICE" }, orderBy: { sortOrder: "asc" } }),
    prisma.subsidyPolicy.findMany(),
  ]);
  return categories.map((c) => ({ category: { id: c.id, name: c.name }, policy: policies.find((p) => p.categoryId === c.id) ?? null }));
}

export async function savePolicy(user: CurrentUser, input: { categoryId: unknown; rateBp: unknown; capFen: unknown; priceCapFen: unknown; startsOn: unknown; endsOn: unknown; isActive?: unknown; note?: unknown }) {
  assertHq(user);
  const categoryId = Number(input.categoryId);
  const category = Number.isInteger(categoryId) ? await prisma.category.findUnique({ where: { id: categoryId } }) : null;
  if (!category || category.kind !== "DEVICE") throw new SubsidyError("国补只能配在大件品类（手机、平板）上");
  const rateBp = Number(input.rateBp);
  if (!Number.isInteger(rateBp) || rateBp < 1 || rateBp > 10000) throw new SubsidyError("补贴比例填 0.01% 到 100% 之间");
  const capFen = Number(input.capFen);
  const priceCapFen = Number(input.priceCapFen);
  if (!isValidFen(capFen) || capFen <= 0) throw new SubsidyError(`单件封顶要大于 0、不超过 ${MAX_AMOUNT_FEN / 1_000_000} 万元`);
  if (!isValidFen(priceCapFen) || priceCapFen <= 0) throw new SubsidyError(`单价上限要大于 0、不超过 ${MAX_AMOUNT_FEN / 1_000_000} 万元`);
  const startsOn = parseDate(input.startsOn, "开始日期");
  const endsOn = parseDate(input.endsOn, "结束日期");
  if (endsOn < startsOn) throw new SubsidyError("结束日期不能早于开始日期");
  const data = { rateBp, capFen, priceCapFen, startsOn, endsOn, isActive: input.isActive !== false, note: text(input.note, 100) || null };
  const policy = await prisma.subsidyPolicy.upsert({ where: { categoryId }, create: { categoryId, ...data }, update: data });
  await writeAudit({ userId: user.id, action: "subsidy.policy.save", entity: "subsidy_policy", entityId: policy.id, detail: { category: category.name, ...data } });
  return policy;
}

// ---------- 开单用 ----------

/** 开单页要的：在用的政策、这个客户已经用过国补的品类（政策期内、没撤销的国补单） */
export async function subsidyContext(db: Db, customerId: number | null, today = todayBizDate()) {
  const rows = await db.subsidyPolicy.findMany({ where: { isActive: true, startsOn: { lte: today }, endsOn: { gte: today } }, include: { category: { select: { name: true } } } });
  const policies: SubsidyPolicyRule[] = rows.map((p) => ({ id: p.id, categoryId: p.categoryId, categoryName: p.category.name, rateBp: p.rateBp, capFen: p.capFen, priceCapFen: p.priceCapFen, startsOn: p.startsOn, endsOn: p.endsOn, isActive: p.isActive }));
  const usedCategoryIds: number[] = [];
  if (customerId) {
    for (const p of policies) {
      const used = await db.subsidyClaim.count({ where: { customerId, categoryId: p.categoryId, status: { in: SUBSIDY_USED_STATUSES }, bizDate: { gte: p.startsOn, lte: p.endsOn } } });
      if (used > 0) usedCategoryIds.push(p.categoryId);
    }
  }
  return { policies, usedCategoryIds };
}

/**
 * 开单前的国补校验（在开单事务里调用）：资格码格式、没被别的国补单用过、按政策挑出要补的那台、平台核验（演示里模拟）。
 * 不符合就抛 SubsidyError，整张单不开。
 */
export async function prepareSubsidyTx(tx: Tx, input: { customerId: number; code: unknown; candidates: SubsidyCandidate[]; today: Date }): Promise<{ code: string; picks: SubsidyPick[] }> {
  const code = normalizeQualificationCode(input.code);
  if (!code) throw new SubsidyError("补贴资格码填顾客在平台领的核销码（8～32 位字母数字）");
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUBSIDY_CUSTOMER_LOCK_NS}::int, ${input.customerId}::int)`;
  const ctx = await subsidyContext(tx, input.customerId, input.today);
  if (ctx.policies.length === 0) throw new SubsidyError("现在没有在用的国补政策");
  const plan = planSubsidy(input.candidates, ctx.policies, new Set(ctx.usedCategoryIds), input.today);
  if (plan.picks.length === 0) throw new SubsidyError(plan.notes[0] ?? `这单没有能用国补的机器（${ctx.policies.map((p) => p.categoryName).join("、")}，成交价在上限以内）`);
  const used = await tx.subsidyClaim.findFirst({ where: { qualificationCode: code, status: { notIn: ["CANCELLED", "RETURNED"] } }, select: { claimNo: true } });
  if (used) throw new SubsidyError(`这个资格码已经在国补单 ${used.claimNo} 上用过了`);
  if (isDemo()) {
    const verified = simulateVerifyQualification(code);
    if (!verified.ok) throw new SubsidyError(verified.reason);
  }
  return { code, picks: plan.picks };
}

/**
 * 开单页的“核对国补”：按现在的单算补哪台、补多少，并核验资格码（演示里模拟）。不写库；提交开单时服务层会在事务里再算一遍。
 */
export async function previewSubsidy(user: CurrentUser, input: { storeId: unknown; customerId: unknown; code: unknown; devices: { deviceId: unknown; unitPriceFen: unknown }[]; subtotalFen: unknown; totalFen: unknown }) {
  if (!canSell(user.role)) throw new SubsidyError("你的角色不能开单");
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) throw new SubsidyError("用国补要先选客户（实名在平台做，系统按客户算每人每类一台）");
  const code = normalizeQualificationCode(input.code);
  if (!code) throw new SubsidyError("补贴资格码填顾客在平台领的核销码（8～32 位字母数字）");
  const subtotalFen = Number(input.subtotalFen);
  const totalFen = Number(input.totalFen);
  if (!isValidFen(subtotalFen) || !isValidFen(totalFen) || totalFen > subtotalFen) throw new SubsidyError("单子的金额不对，改好再核对");
  const store = await prisma.store.findUnique({ where: { id: Number(input.storeId) }, select: { id: true, regionId: true } });
  if (!store) throw new SubsidyError("门店不存在");
  wrapAccess(() => assertStoreAccess(user, store));
  const price = new Map((Array.isArray(input.devices) ? input.devices : []).map((d) => [Number(d.deviceId), Number(d.unitPriceFen)]));
  const devices = await prisma.device.findMany({ where: { id: { in: [...price.keys()].filter((id) => Number.isInteger(id)) }, storeId: store.id }, include: { sku: { select: { model: { select: { categoryId: true } } } } } });
  const candidates = devices.filter((d) => d.tradeInOrderId === null && isValidFen(price.get(d.id) ?? NaN)).map((d) => ({ key: d.id, categoryId: d.sku.model.categoryId, baseFen: lineBaseFen(price.get(d.id)!, subtotalFen, totalFen) }));
  const today = todayBizDate();
  const ctx = await subsidyContext(prisma, customerId, today);
  if (ctx.policies.length === 0) throw new SubsidyError("现在没有在用的国补政策");
  const plan = planSubsidy(candidates, ctx.policies, new Set(ctx.usedCategoryIds), today);
  if (plan.picks.length === 0) throw new SubsidyError(plan.notes[0] ?? `这单没有能用国补的新机（${ctx.policies.map((p) => p.categoryName).join("、")}，成交价在上限以内）`);
  const used = await prisma.subsidyClaim.findFirst({ where: { qualificationCode: code, status: { notIn: ["CANCELLED", "RETURNED"] } }, select: { claimNo: true } });
  if (used) throw new SubsidyError(`这个资格码已经在国补单 ${used.claimNo} 上用过了`);
  if (isDemo()) {
    const verified = simulateVerifyQualification(code);
    if (!verified.ok) throw new SubsidyError(verified.reason);
  }
  const names = new Map(ctx.policies.map((p) => [p.categoryId, p.categoryName]));
  return { code, subsidyFen: plan.picks.reduce((s, p) => s + p.subsidyFen, 0), picks: plan.picks.map((p) => ({ deviceId: p.key, categoryName: names.get(p.categoryId) ?? "", baseFen: p.baseFen, subsidyFen: p.subsidyFen })), notes: plan.notes };
}

/** 开单页上的政策说明，比如“手机、平板：成交价的 15%，单件最多 500 元，6000 元以内” */
export async function subsidyHint(): Promise<string | null> {
  const { policies } = await subsidyContext(prisma, null);
  if (policies.length === 0) return null;
  return policies.map((p) => `${p.categoryName}：成交价的 ${p.rateBp / 100}%，单件最多 ${p.capFen / 100} 元，${p.priceCapFen / 100} 元以内`).join("；");
}

/** 开单时每台补贴的机器建一张国补单（待提交） */
export async function createClaimsTx(
  tx: Tx,
  input: { storeId: number; salesOrderId: number; customerId: number; bizDate: Date; code: string; lines: { salesOrderItemId: number; deviceId: number; policyId: number; categoryId: number; baseFen: number; subsidyFen: number }[] },
) {
  for (const l of input.lines) {
    const claimNo = await nextDocNo(tx, "GB");
    try {
      await tx.subsidyClaim.create({
        data: { claimNo, storeId: input.storeId, salesOrderId: input.salesOrderId, salesOrderItemId: l.salesOrderItemId, customerId: input.customerId, deviceId: l.deviceId, policyId: l.policyId, categoryId: l.categoryId, bizDate: input.bizDate, basePriceFen: l.baseFen, subsidyFen: l.subsidyFen, qualificationCode: input.code },
      });
    } catch (error) {
      // 两家店同时用同一个资格码：先查后插都查不到，最后靠部分唯一索引 subsidy_claims_code_active_key 拦下
      if (isUniqueViolation(error)) throw new SubsidyError("这个资格码刚被别的单用了，一个码只能补一台");
      throw error;
    }
  }
}

/**
 * 作废销售单、退掉补贴的机器：没到账的撤销，已到账的标“需退回”（钱要退给平台）。
 * 已撤销、已退回、需退回的不动。返回动了几张。
 */
export async function cancelClaimsTx(tx: Tx, where: { salesOrderId: number } | { salesOrderItemIds: number[] }) {
  const filter = "salesOrderId" in where ? { salesOrderId: where.salesOrderId } : { salesOrderItemId: { in: where.salesOrderItemIds } };
  const now = new Date();
  const cancelled = await tx.subsidyClaim.updateMany({ where: { ...filter, status: { in: ["PENDING", "SUBMITTED", "APPROVED", "REJECTED"] } }, data: { status: "CANCELLED", cancelledAt: now } });
  const returnDue = await tx.subsidyClaim.updateMany({ where: { ...filter, status: "SETTLED" }, data: { status: "RETURN_DUE", cancelledAt: now } });
  return cancelled.count + returnDue.count;
}

// ---------- 门店：补资料提交审核 ----------

async function lockClaim(tx: Tx, user: CurrentUser, id: number) {
  if (!(await lockRow(tx, "subsidy_claims", id))) throw new SubsidyError("国补单不存在");
  const claim = await tx.subsidyClaim.findUniqueOrThrow({ where: { id }, include: { store: { select: { id: true, regionId: true } } } });
  wrapAccess(() => assertStoreAccess(user, claim.store));
  return claim;
}

/** 补上发票号提交平台审核（真用时是把发票、串号照片传到平台）；被驳回的改好资料也从这里重新提交 */
export async function submitClaimTx(tx: Tx, user: CurrentUser, id: number, invoiceNo: unknown) {
  if (!canSell(user.role)) throw new SubsidyError("你的角色不能提交国补");
  const claim = await lockClaim(tx, user, id);
  if (claim.status !== "PENDING" && claim.status !== "REJECTED") throw new SubsidyError("待提交、被驳回的国补单才能提交审核");
  // 不填就用这张销售单已经开好的发票号码（口径第 16 节）
  const typed = typeof invoiceNo === "string" ? invoiceNo.trim() : "";
  if (typed.length > 30) throw new SubsidyError("发票号是 6～30 位字母数字");
  // 上次提交记下的号，如果这张票后来红冲了（退货后红冲、按剩下的重开），就不能再用，换成现在已开的
  const saved = claim.invoiceNo && !(await isReddedOnOrder(tx, claim.salesOrderId, claim.invoiceNo)) ? claim.invoiceNo : null;
  if (typed && (await isReddedOnOrder(tx, claim.salesOrderId, typed))) throw new SubsidyError(`发票 ${typed} 已经红冲了，填现在有效的发票号，或者不填用这张单已开的`);
  const invoice = typed || saved || (await issuedInvoiceNumber(tx, claim.salesOrderId)) || "";
  if (!invoice) throw new SubsidyError("这张销售单还没开票：先申请开票、等总部开好，或者直接填发票号");
  if (!/^[A-Za-z0-9-]{6,30}$/.test(invoice)) throw new SubsidyError("发票号是 6～30 位字母数字");
  await tx.subsidyClaim.update({ where: { id }, data: { status: "SUBMITTED", invoiceNo: invoice, submittedAt: new Date(), rejectReason: null } });
  await writeAudit({ userId: user.id, action: claim.status === "REJECTED" ? "subsidy.claim.resubmit" : "subsidy.claim.submit", entity: "subsidy_claim", entityId: id, detail: { claimNo: claim.claimNo, invoiceNo: invoice } }, tx);
}

// ---------- 总部：平台结果、退回 ----------

async function applyLinesTx(tx: Tx, user: CurrentUser, lines: PlatformResultLine[], source: "FILE" | "SIMULATED") {
  const now = new Date();
  const result = { applied: 0, skipped: [] as { code: string; reason: string }[], unmatched: [] as string[], amountDiff: [] as { claimNo: string; subsidyFen: number; settledFen: number }[] };
  for (const line of lines) {
    const claim = await tx.subsidyClaim.findFirst({ where: { qualificationCode: line.code, status: { notIn: ["CANCELLED", "RETURNED"] } }, orderBy: { id: "desc" } });
    if (!claim) {
      result.unmatched.push(line.code);
      continue;
    }
    await lockRow(tx, "subsidy_claims", claim.id);
    const fresh = await tx.subsidyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    const step = applyPlatformResult(fresh.status, line.result);
    if ("skip" in step) {
      result.skipped.push({ code: line.code, reason: `${fresh.claimNo}：${step.skip}` });
      continue;
    }
    const data: Prisma.SubsidyClaimUpdateInput =
      step.next === "APPROVED"
        ? { status: "APPROVED", reviewedAt: now }
        : step.next === "REJECTED"
          ? { status: "REJECTED", reviewedAt: now, rejectReason: line.reason ?? "平台驳回（没写原因）" }
          : { status: "SETTLED", reviewedAt: fresh.reviewedAt ?? now, settledAt: now, settledFen: line.amountFen > 0 ? line.amountFen : fresh.subsidyFen };
    await tx.subsidyClaim.update({ where: { id: claim.id }, data });
    if (step.next === "SETTLED" && line.amountFen > 0 && line.amountFen !== fresh.subsidyFen) result.amountDiff.push({ claimNo: fresh.claimNo, subsidyFen: fresh.subsidyFen, settledFen: line.amountFen });
    result.applied++;
  }
  await writeAudit({ userId: user.id, action: "subsidy.import", entity: "subsidy_claim", detail: { source, lines: lines.length, applied: result.applied, skipped: result.skipped.length, unmatched: result.unmatched.length, amountDiff: result.amountDiff.length } }, tx);
  return result;
}

/** 导入平台导出的审核 / 到账结果表格（真用的路子） */
export async function importPlatformResults(user: CurrentUser, csv: unknown, db: Db = prisma) {
  assertHq(user);
  let lines: PlatformResultLine[];
  try {
    lines = parsePlatformResultCsv(typeof csv === "string" ? csv : "");
  } catch (error) {
    if (error instanceof SubsidyParseError) throw new SubsidyError(error.message);
    throw error;
  }
  if (lines.length > 5000) throw new SubsidyError("一次最多导入 5000 行");
  return withTx(db, (tx) => applyLinesTx(tx, user, lines, "FILE"));
}

const REJECT_REASONS = ["发票抬头和顾客实名不一致", "串号照片看不清", "成交价和发票金额对不上"];

/** 模拟器：平台审核（演示用）：审核中的九成五通过，其余驳回 */
export async function simulateReview(user: CurrentUser, options: { db?: Db; random?: () => number } = {}) {
  if (!isDemo()) throw new SubsidyError("模拟审核只能在演示里用；真用请导入平台导出的结果表格");
  assertHq(user);
  const random = options.random ?? Math.random;
  return withTx(options.db ?? prisma, async (tx) => {
    const rows = await tx.subsidyClaim.findMany({ where: { status: "SUBMITTED" }, select: { qualificationCode: true } });
    const lines: PlatformResultLine[] = rows.map((r) => (random() < 0.95 ? { code: r.qualificationCode, result: "APPROVED", amountFen: 0, reason: null } : { code: r.qualificationCode, result: "REJECTED", amountFen: 0, reason: REJECT_REASONS[Math.floor(random() * REJECT_REASONS.length)]! }));
    return applyLinesTx(tx, user, lines, "SIMULATED");
  });
}

/** 模拟器：平台到账（演示用）：待到账的全部按补贴金额到账 */
export async function simulateSettle(user: CurrentUser, options: { db?: Db } = {}) {
  if (!isDemo()) throw new SubsidyError("模拟到账只能在演示里用；真用请导入平台导出的结果表格");
  assertHq(user);
  return withTx(options.db ?? prisma, async (tx) => {
    const rows = await tx.subsidyClaim.findMany({ where: { status: "APPROVED" }, select: { qualificationCode: true, subsidyFen: true } });
    return applyLinesTx(tx, user, rows.map((r) => ({ code: r.qualificationCode, result: "SETTLED" as const, amountFen: r.subsidyFen, reason: null })), "SIMULATED");
  });
}

/** 已到账后退货的，总部把钱退给平台后标记“已退回” */
export async function markReturnedTx(tx: Tx, user: CurrentUser, id: number) {
  assertHq(user);
  const claim = await lockClaim(tx, user, id);
  if (claim.status !== "RETURN_DUE") throw new SubsidyError("需退回的国补单才能标记已退回");
  await tx.subsidyClaim.update({ where: { id }, data: { status: "RETURNED", returnedAt: new Date() } });
  await writeAudit({ userId: user.id, action: "subsidy.claim.returned", entity: "subsidy_claim", entityId: id, detail: { claimNo: claim.claimNo } }, tx);
}

export const subsidyActions = {
  submit: (user: CurrentUser, id: number, invoiceNo: unknown) => withTx(prisma, (tx) => submitClaimTx(tx, user, id, invoiceNo)),
  markReturned: (user: CurrentUser, id: number) => withTx(prisma, (tx) => markReturnedTx(tx, user, id)),
};

// ---------- 查询 ----------

export const SUBSIDY_PAGE_SIZE = 20;

export interface SubsidyQuery {
  status?: SubsidyClaimStatus;
  storeId?: number;
  month?: string;
  q?: string;
  page?: number;
}

function claimWhere(user: CurrentUser, query: SubsidyQuery): Prisma.SubsidyClaimWhereInput {
  const q = (query.q ?? "").trim();
  const range = query.month && /^\d{4}-\d{2}$/.test(query.month) ? monthRange(query.month) : null;
  return {
    AND: [
      storeScopeWhere(user),
      query.storeId ? { storeId: query.storeId } : {},
      query.status ? { status: query.status } : {},
      range ? { bizDate: { gte: range.from, lt: range.to } } : {},
      q
        ? { OR: [{ claimNo: { contains: q, mode: "insensitive" } }, { qualificationCode: { contains: q.toUpperCase() } }, { salesOrder: { orderNo: { contains: q, mode: "insensitive" } } }, { device: { code: { contains: q } } }] }
        : {},
    ],
  };
}

/** 国补订单明细：店员店长本店，区域经理辖区（只读），总部全部 */
export async function listClaims(user: CurrentUser, query: SubsidyQuery) {
  const page = clampPage(query.page);
  const where = claimWhere(user, query);
  const [rows, total] = await Promise.all([
    prisma.subsidyClaim.findMany({
      where,
      orderBy: [{ bizDate: "desc" }, { id: "desc" }],
      skip: (page - 1) * SUBSIDY_PAGE_SIZE,
      take: SUBSIDY_PAGE_SIZE,
      include: {
        store: { select: { code: true, name: true } },
        customer: { select: { id: true, name: true, phone: true } },
        salesOrder: { select: { id: true, orderNo: true } },
        device: { select: { code: true, sku: { select: { name: true } } } },
        category: { select: { name: true } },
      },
    }),
    prisma.subsidyClaim.count({ where }),
  ]);
  return {
    rows: rows.map(({ customer, ...r }) => ({ ...r, customer: { id: customer.id, name: customer.name, phoneMasked: maskPhone(customer.phone) } })),
    total,
    page,
    pageSize: SUBSIDY_PAGE_SIZE,
    can: { submit: canSell(user.role), manage: canManageSubsidy(user.role), simulate: isDemo() && canManageSubsidy(user.role) },
  };
}

export type SubsidyClaimRow = Awaited<ReturnType<typeof listClaims>>["rows"][number];

/** 汇总：按门店看国补应收、本月补贴、被驳回、需退回（范围同明细） */
export async function subsidySummary(user: CurrentUser, query: { storeId?: number }) {
  const today = todayBizDate();
  const { from, to } = monthRange(today.toISOString().slice(0, 7));
  const rows = await prisma.subsidyClaim.findMany({
    where: { AND: [storeScopeWhere(user), query.storeId ? { storeId: query.storeId } : {}] },
    select: { status: true, subsidyFen: true, settledFen: true, bizDate: true, store: { select: { id: true, code: true, name: true } } },
  });
  type Agg = { storeId: number; label: string; receivableFen: number; monthFen: number; monthCount: number; rejectedFen: number; returnDueFen: number; settledFen: number; shortFen: number };
  const byStore = new Map<number, Agg>();
  for (const r of rows) {
    const a = byStore.get(r.store.id) ?? { storeId: r.store.id, label: `${r.store.code} ${r.store.name}`, receivableFen: 0, monthFen: 0, monthCount: 0, rejectedFen: 0, returnDueFen: 0, settledFen: 0, shortFen: 0 };
    if (SUBSIDY_RECEIVABLE_STATUSES.includes(r.status)) a.receivableFen += r.subsidyFen;
    if (r.status === "REJECTED") a.rejectedFen += r.subsidyFen;
    if (r.status === "RETURN_DUE") a.returnDueFen += r.settledFen ?? r.subsidyFen;
    if (r.status === "SETTLED") a.settledFen += r.settledFen ?? 0;
    // 到账差额：应到（补贴）− 实到，少到账为正、多到账为负
    if (r.status === "SETTLED" && r.settledFen !== null) a.shortFen += r.subsidyFen - r.settledFen;
    if (r.status !== "CANCELLED" && r.bizDate >= from && r.bizDate < to) {
      a.monthFen += r.subsidyFen;
      a.monthCount++;
    }
    byStore.set(r.store.id, a);
  }
  const stores = Array.from(byStore.values()).sort((x, y) => y.receivableFen - x.receivableFen);
  const sum = (k: keyof Omit<Agg, "storeId" | "label">) => stores.reduce((s, a) => s + a[k], 0);
  return { stores, total: { receivableFen: sum("receivableFen"), monthFen: sum("monthFen"), monthCount: sum("monthCount"), rejectedFen: sum("rejectedFen"), returnDueFen: sum("returnDueFen"), settledFen: sum("settledFen"), shortFen: sum("shortFen") } };
}

/** 销售单详情里的国补单 */
export async function claimsForOrder(salesOrderId: number) {
  return prisma.subsidyClaim.findMany({ where: { salesOrderId }, orderBy: { id: "asc" }, select: { id: true, claimNo: true, status: true, subsidyFen: true, basePriceFen: true, qualificationCode: true, device: { select: { code: true } }, rejectReason: true } });
}
