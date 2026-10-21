import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { addDays, bjDateKey, dateFromKey, dateKeyOf, isDateKey, isMonthKey, monthDates } from "@/lib/attendance";
import {
  EXPENSE_BACKDATE_DAYS,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_HQ_FEN,
  EXPENSE_MAX_FEN,
  EXPENSE_PAY_METHODS,
  expenseChain,
  type ExpenseCategoryKey,
  type ExpensePayMethodKey,
  type ExpenseStatusKey,
} from "@/lib/expense";
import { formatFen } from "@/lib/format";
import { clampPage, isDbId } from "@/lib/paging";
import { canAccessStoreSafe, storeTableWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { ApprovalError, cancelRequest, createOaApprovalTx } from "@/server/approval/approval-service";
import { writeAudit } from "@/server/audit";
import { lockRow } from "@/server/db-lock";
import { type Db, withTx } from "@/server/db-tx";
import { nextDocNo } from "@/server/stock/doc-no";
import { ExpenseError } from "./expense-executor";

// 费用报销（口径第 19 节）：员工提交（类型、金额、发生日期、说明、算哪家门店的），走审批：门店店员 2000 元以下店长批，
// 2000 元及以上店长批完总部再批；店长自己的、总部和区域经理的直接总部批；不能批自己的。批了是“待付款”，
// 总部财务付完点“已付款”（记付款方式、日期），按付款日期算进门店当月的费用。这一版不做发票附件、借款、预付。

export { ExpenseError };

export const EXPENSE_PAGE_SIZE = 20;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 能付款的人：总部（财务在总部） */
export function canPayExpense(role: CurrentUser["role"]): boolean {
  return role === "HQ";
}

/**
 * 算哪家门店的：店员、店长只能算本店；区域经理能选辖区的门店或者不挂（区域的费用）；总部能选任何门店或者不挂（总部的费用）
 */
async function resolveStore(db: Db, user: CurrentUser, raw: unknown): Promise<number | null> {
  if (user.role === "STAFF" || user.role === "STORE_MANAGER") {
    if (!user.storeId) throw new ExpenseError("你还没分配门店");
    return user.storeId;
  }
  if (raw === undefined || raw === null || raw === "") return null;
  const storeId = Number(raw);
  if (!isDbId(storeId)) throw new ExpenseError("门店不对");
  const store = await db.store.findFirst({ where: { id: storeId, isActive: true }, select: { id: true, regionId: true } });
  if (!store || !canAccessStoreSafe(user, store)) throw new ExpenseError("选一家你范围内、在营业的门店");
  return storeId;
}

export async function submitExpense(
  user: CurrentUser,
  input: { category: unknown; amountFen: unknown; occurredOn: unknown; description: unknown; storeId?: unknown },
  opts: { db?: Db; now?: Date } = {},
) {
  const db = opts.db ?? prisma;
  const category = input.category as ExpenseCategoryKey;
  if (!EXPENSE_CATEGORIES.includes(category)) throw new ExpenseError("选一下费用类型");
  const amountFen = Number(input.amountFen);
  if (!Number.isFinite(amountFen) || amountFen <= 0) throw new ExpenseError("金额要大于 0");
  if (!Number.isInteger(amountFen)) throw new ExpenseError("金额最小到分");
  if (amountFen > EXPENSE_MAX_FEN) throw new ExpenseError(`一张最多报 ${formatFen(EXPENSE_MAX_FEN)} 元，多的分开报`);
  if (!isDateKey(input.occurredOn)) throw new ExpenseError("选一下发生日期");
  const today = bjDateKey(opts.now ?? new Date());
  if (input.occurredOn > today) throw new ExpenseError("发生日期不能是以后的日子");
  if (input.occurredOn < addDays(today, -EXPENSE_BACKDATE_DAYS)) throw new ExpenseError(`只能报 ${EXPENSE_BACKDATE_DAYS} 天以内发生的费用`);
  const description = text(input.description, 200);
  if (!description) throw new ExpenseError("写一下是什么费用（比如：给中山路店买打印纸）");
  const occurredOn = input.occurredOn;
  return withTx(db, async (tx) => {
    const storeId = await resolveStore(tx, user, input.storeId);
    const chain = expenseChain(user.role, user.storeId !== null && storeId === user.storeId, amountFen);
    const claimNo = await nextDocNo(tx, "BX");
    const claim = await tx.expenseClaim.create({ data: { claimNo, userId: user.id, storeId, category, amountFen, occurredOn: dateFromKey(occurredOn), description } });
    const label = EXPENSE_CATEGORY_LABELS[category];
    const store = storeId ? await tx.store.findUnique({ where: { id: storeId }, select: { code: true, name: true } }) : null;
    const approval = await createOaApprovalTx(tx, user, {
      action: "EXPENSE",
      // 门店店员的报销挂本店（店长能批）；其他人的挂所算的门店，不算门店的就不挂（只有发起人和总部看得到）
      storeId,
      chain,
      summary: `${user.name} 报销${label} ${formatFen(amountFen)} 元（${store ? store.name : "总部"}）`,
      reason: chain.length > 1 ? `报销 ${formatFen(amountFen)} 元（${formatFen(EXPENSE_HQ_FEN)} 元及以上），店长批完总部再批` : "报销要审批",
      amountFen,
      payload: { action: "EXPENSE", claimId: claim.id, details: [`单号：${claimNo}`, `类型：${label}`, `金额：${formatFen(amountFen)} 元`, `发生日期：${occurredOn}`, `算哪家的：${store ? `${store.code} ${store.name}` : "总部"}`, `说明：${description}`] },
      dedupeKey: `EXPENSE:${claim.id}`,
    });
    await tx.expenseClaim.update({ where: { id: claim.id }, data: { approvalRequestId: approval.id } });
    await writeAudit({ userId: user.id, action: "expense.submit", entity: "expense_claim", entityId: claim.id, detail: { claimNo, category, amountFen, storeId, requestNo: approval.requestNo } }, tx);
    return { id: claim.id, claimNo, requestNo: approval.requestNo, chain, autoApproved: approval.autoApproved };
  });
}

/** 撤回自己审批中的报销（就是撤回那张审批单） */
export async function cancelExpense(user: CurrentUser, claimId: number, db: Db = prisma) {
  const claim = await db.expenseClaim.findUnique({ where: { id: claimId }, select: { userId: true, status: true, approvalRequestId: true } });
  if (!claim || claim.userId !== user.id) throw new ExpenseError("只能撤回自己的报销");
  if (claim.status !== "PENDING" || !claim.approvalRequestId) throw new ExpenseError("这张报销单已经批完了，不能撤回");
  try {
    await cancelRequest(user, claim.approvalRequestId, db);
  } catch (error) {
    if (error instanceof ApprovalError) throw new ExpenseError(error.message);
    throw error;
  }
}

const NOT_PAYABLE: Partial<Record<ExpenseStatusKey, string>> = { PENDING: "还在审批中，批下来才能付款", REJECTED: "这张已经驳回了，不能付款", CANCELLED: "这张已经撤回了，不能付款", PAID: "已经付过款了" };

function parsePayment(input: { payMethod: unknown; paidOn: unknown; note?: unknown }, now: Date) {
  const payMethod = input.payMethod as ExpensePayMethodKey;
  if (!EXPENSE_PAY_METHODS.includes(payMethod)) throw new ExpenseError("选一下付款方式");
  if (!isDateKey(input.paidOn)) throw new ExpenseError("选一下付款日期");
  if (input.paidOn > bjDateKey(now)) throw new ExpenseError("付款日期不能是以后的日子");
  return { payMethod, paidOn: input.paidOn, note: text(input.note, 100) || null };
}

/** 付款日期最早能写到哪天：批下来那天（北京时间），也不能早于费用发生日期 */
async function earliestPayDate(tx: Prisma.TransactionClient, claim: { approvalRequestId: number | null; occurredOn: Date }): Promise<string> {
  const approval = claim.approvalRequestId ? await tx.approvalRequest.findUnique({ where: { id: claim.approvalRequestId }, select: { decidedAt: true } }) : null;
  const approvedOn = approval?.decidedAt ? bjDateKey(approval.decidedAt) : dateKeyOf(claim.occurredOn);
  const occurred = dateKeyOf(claim.occurredOn);
  return approvedOn > occurred ? approvedOn : occurred;
}

/** 总部财务付完款点“已付款”：记付款方式、日期（不早于批下来那天，不能是以后的日子） */
export async function markExpensePaid(user: CurrentUser, claimId: number, input: { payMethod: unknown; paidOn: unknown; note?: unknown }, opts: { db?: Db; now?: Date } = {}) {
  if (!canPayExpense(user.role)) throw new ExpenseError("报销付款只有总部能登记");
  const { payMethod, paidOn, note } = parsePayment(input, opts.now ?? new Date());
  return withTx(opts.db ?? prisma, async (tx) => {
    if (!(await lockRow(tx, "expense_claims", claimId))) throw new ExpenseError("报销单不存在");
    const claim = await tx.expenseClaim.findUniqueOrThrow({ where: { id: claimId } });
    if (claim.status !== "APPROVED") throw new ExpenseError(NOT_PAYABLE[claim.status] ?? "这张不能付款");
    const earliest = await earliestPayDate(tx, claim);
    if (paidOn < earliest) throw new ExpenseError(`付款日期不能早于 ${earliest}（批下来那天）`);
    await tx.expenseClaim.update({ where: { id: claimId }, data: { status: "PAID", paidOn: dateFromKey(paidOn), payMethod, payNote: note, paidById: user.id } });
    await writeAudit({ userId: user.id, action: "expense.pay", entity: "expense_claim", entityId: claimId, detail: { claimNo: claim.claimNo, amountFen: claim.amountFen, payMethod, paidOn } }, tx);
  });
}

/**
 * 登记错了：改付款（方式、日期、备注）或撤销付款（回到待付款），要写原因、记日志（原来 → 改成）。
 * 只能改这个月付的：过完的月份费用数字就定了（门店收支按付款日期算），上个月的记错了在这个月另外处理。
 */
export async function changeExpensePayment(
  user: CurrentUser,
  claimId: number,
  input: { action: "EDIT" | "UNDO"; reason: unknown; payMethod?: unknown; paidOn?: unknown; note?: unknown },
  opts: { db?: Db; now?: Date } = {},
) {
  if (!canPayExpense(user.role)) throw new ExpenseError("报销付款只有总部能改");
  const now = opts.now ?? new Date();
  const reason = text(input.reason, 100);
  if (!reason) throw new ExpenseError("写一下为什么改");
  const monthStart = `${bjDateKey(now).slice(0, 7)}-01`;
  const next = input.action === "EDIT" ? parsePayment({ payMethod: input.payMethod, paidOn: input.paidOn, note: input.note }, now) : null;
  if (input.action !== "EDIT" && input.action !== "UNDO") throw new ExpenseError("操作不对");
  return withTx(opts.db ?? prisma, async (tx) => {
    if (!(await lockRow(tx, "expense_claims", claimId))) throw new ExpenseError("报销单不存在");
    const claim = await tx.expenseClaim.findUniqueOrThrow({ where: { id: claimId } });
    if (claim.status !== "PAID" || !claim.paidOn) throw new ExpenseError("这张还没登记付款");
    const before = { paidOn: dateKeyOf(claim.paidOn), payMethod: claim.payMethod, note: claim.payNote };
    if (before.paidOn < monthStart) throw new ExpenseError("上个月以前付的款不能改了（过完的月份费用数字已经定了）");
    if (next) {
      if (next.paidOn < monthStart) throw new ExpenseError(`只能改成这个月（${monthStart} 以后）的日期`);
      const earliest = await earliestPayDate(tx, claim);
      if (next.paidOn < earliest) throw new ExpenseError(`付款日期不能早于 ${earliest}（批下来那天）`);
      await tx.expenseClaim.update({ where: { id: claimId }, data: { paidOn: dateFromKey(next.paidOn), payMethod: next.payMethod, payNote: next.note, paidById: user.id } });
    } else {
      await tx.expenseClaim.update({ where: { id: claimId }, data: { status: "APPROVED", paidOn: null, payMethod: null, payNote: null, paidById: null } });
    }
    await writeAudit({ userId: user.id, action: next ? "expense.pay_edit" : "expense.pay_undo", entity: "expense_claim", entityId: claimId, detail: { claimNo: claim.claimNo, reason, before, after: next ? { paidOn: next.paidOn, payMethod: next.payMethod, note: next.note } : null } }, tx);
  });
}

export type ExpenseView = "mine" | "team" | "topay";

/** 能看谁的报销：自己的；店长本店、区域经理辖区（按算哪家门店）；总部全部 */
function teamWhere(user: CurrentUser): Prisma.ExpenseClaimWhereInput {
  switch (user.role) {
    case "HQ":
      return {};
    case "REGIONAL_MANAGER":
      return { OR: [{ store: { regionId: user.regionId ?? -1 } }, { userId: user.id }] };
    case "STORE_MANAGER":
      return { storeId: user.storeId ?? -1 };
    case "STAFF":
      return { userId: user.id };
  }
}

export async function listExpenses(user: CurrentUser, query: { view?: ExpenseView; month?: string; status?: ExpenseStatusKey; storeId?: number; page?: number }) {
  const team = user.role !== "STAFF";
  const views: ExpenseView[] = ["mine", ...(team ? (["team"] as const) : []), ...(canPayExpense(user.role) ? (["topay"] as const) : [])];
  const view: ExpenseView = query.view && views.includes(query.view) ? query.view : canPayExpense(user.role) ? "topay" : team ? "team" : "mine";
  const page = clampPage(query.page);
  const month = isMonthKey(query.month) ? query.month : null;
  const stores = team ? await prisma.store.findMany({ where: storeTableWhere(user), orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }) : [];
  const storeId = query.storeId && stores.some((s) => s.id === query.storeId) ? query.storeId : null;
  const where: Prisma.ExpenseClaimWhereInput = {
    AND: [
      view === "mine" ? { userId: user.id } : view === "topay" ? { status: "APPROVED" } : teamWhere(user),
      month ? { occurredOn: { gte: dateFromKey(`${month}-01`), lte: dateFromKey(monthDates(month).at(-1)!) } } : {},
      query.status && view !== "topay" ? { status: query.status } : {},
      storeId && view !== "mine" ? { storeId } : {},
    ],
  };
  const [rows, total, sums] = await Promise.all([
    prisma.expenseClaim.findMany({
      where,
      orderBy: [{ id: "desc" }],
      skip: (page - 1) * EXPENSE_PAGE_SIZE,
      take: EXPENSE_PAGE_SIZE,
      include: { user: { select: { name: true } }, store: { select: { code: true, name: true } }, paidBy: { select: { name: true } } },
    }),
    prisma.expenseClaim.count({ where }),
    prisma.expenseClaim.groupBy({ by: ["status"], where, _sum: { amountFen: true }, _count: { _all: true } }),
  ]);
  const approvals = await prisma.approvalRequest.findMany({
    where: { id: { in: rows.map((r) => r.approvalRequestId).filter((id): id is number => id !== null) } },
    select: { id: true, requestNo: true, approverRole: true, step: true, chain: true, status: true, decisionNote: true },
  });
  return {
    view,
    views,
    team,
    canPay: canPayExpense(user.role),
    stores,
    storeId,
    page,
    pageSize: EXPENSE_PAGE_SIZE,
    total,
    totals: Object.fromEntries(sums.map((s) => [s.status, { count: s._count._all, amountFen: s._sum.amountFen ?? 0 }])) as Partial<Record<ExpenseStatusKey, { count: number; amountFen: number }>>,
    myStore: user.store?.name ?? null,
    rows: rows.map((r) => {
      const a = approvals.find((x) => x.id === r.approvalRequestId) ?? null;
      return {
        id: r.id,
        claimNo: r.claimNo,
        name: r.user.name,
        store: r.store ? `${r.store.code} ${r.store.name}` : "总部",
        category: r.category,
        amountFen: r.amountFen,
        occurredOn: dateKeyOf(r.occurredOn),
        description: r.description,
        status: r.status,
        createdAt: r.createdAt,
        paid: r.paidOn ? { on: dateKeyOf(r.paidOn), method: r.payMethod!, by: r.paidBy?.name ?? "", note: r.payNote } : null,
        mine: r.userId === user.id,
        approval: a ? { id: a.id, requestNo: a.requestNo, approverRole: a.approverRole, step: a.step, steps: Math.max(1, a.chain.length), note: a.status === "REJECTED" ? a.decisionNote : null } : null,
      };
    }),
  };
}

export type ExpenseList = Awaited<ReturnType<typeof listExpenses>>;

/** 门店某个月已付款的报销合计（门店收支和利润表用，按付款日期） */
export async function paidExpensesByStore(db: Db, month: string): Promise<Map<number | null, number>> {
  if (!isMonthKey(month)) throw new ExpenseError("月份不对，格式是 2026-10"); // 网址里取的月份可能是乱填的
  const rows = await db.expenseClaim.groupBy({
    by: ["storeId"],
    where: { status: "PAID", paidOn: { gte: dateFromKey(`${month}-01`), lte: dateFromKey(monthDates(month).at(-1)!) } },
    _sum: { amountFen: true },
  });
  return new Map(rows.map((r) => [r.storeId, r._sum.amountFen ?? 0]));
}
