import "server-only";
import { prisma } from "@/lib/prisma";
import { bjDateKey, dateFromKey, isMonthKey, monthDates } from "@/lib/attendance";
import { computePnl, FIXED_EXPENSE_CATEGORIES, FIXED_EXPENSE_LABELS, sumPnl, type FixedExpenseCategoryKey, type PnlNumbers } from "@/lib/pnl";
import { isDbId } from "@/lib/paging";
import type { CurrentUser } from "@/server/auth/current-user";
import { canAccessStoreSafe, storeTableWhere } from "@/server/auth/scope";
import { writeAudit } from "@/server/audit";
import { type Db, withTx } from "@/server/db-tx";
import { payrollCostByStore } from "@/server/hr/payroll-service";
import { paidExpensesByStore } from "./expense-service";

// 门店收支和利润表（口径第 19 节）：按门店 × 月。
// 收入 = 销售额（应收扣退款，和看板同一个口径）+ 运营商佣金（这个月办的、没作废没失败的，按政策记的预计佣金）+ 维修收费（这个月取机结算的）；
// 销货成本 = 卖出的机器、配件成本（退货冲回）+ 维修成本；毛利 = 收入 − 销货成本；
// 费用 = 已付款的报销（按付款日期）+ 这个月已发布工资条的应发（按那天在哪家店分摊）+ 门店固定支出（店长或总部每月录）
// + 国补驳回（这个月被平台驳回、现在还是驳回的补贴，门店承担；改了重新提交就不算了）；利润 = 毛利 − 费用。
// 工资条没发布、固定支出没录的标“数据不全”。看：店长本店，区域经理辖区（只看），总部全部（多一行“总部”的报销和工资、有合计）。
// 停用的店：那个月有数据就照样列出来（标“已停用”、不能录），以前月份的合计不会因为关店变掉。

export class PnlError extends Error {}

const MAX_FIXED_FEN = 10_000_000; // 固定支出一项一月最多 10 万元

/** 谁能录这家店的固定支出：总部、这家店的店长 */
export function canEditFixed(user: CurrentUser, storeId: number): boolean {
  return user.role === "HQ" || (user.role === "STORE_MANAGER" && user.storeId === storeId);
}

function monthRange(month: string) {
  return { gte: dateFromKey(`${month}-01`), lte: dateFromKey(monthDates(month).at(-1)!) };
}

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** 这几家店这个月的收入和销货成本（销售、退货、运营商、维修），和国补驳回 */
async function storeRevenue(db: Db, month: string, ids: number[]) {
  const r = monthRange(month);
  const [sales, goodsCost, returns, carrier, repair, subsidyLoss] = await Promise.all([
    db.$queryRaw<{ store_id: number; v: bigint }[]>`SELECT store_id, SUM(total_fen)::bigint AS v FROM sales_orders WHERE status = 'COMPLETED' AND biz_date BETWEEN ${r.gte} AND ${r.lte} AND store_id = ANY(${ids}) GROUP BY 1`,
    db.$queryRaw<{ store_id: number; v: bigint }[]>`SELECT o.store_id, SUM(i.cost_fen)::bigint AS v FROM sales_order_items i JOIN sales_orders o ON o.id = i.order_id WHERE o.status = 'COMPLETED' AND o.biz_date BETWEEN ${r.gte} AND ${r.lte} AND o.store_id = ANY(${ids}) GROUP BY 1`,
    // 退货：退款冲销售额、退回的成本冲销货成本（和看板一样按销售明细的成本快照分摊）
    db.$queryRaw<{ store_id: number; refund: bigint; cost: bigint }[]>`
      SELECT t.store_id, SUM(ri.refund_fen)::bigint AS refund, SUM((si.cost_fen / si.qty) * ri.qty)::bigint AS cost
      FROM return_orders t JOIN return_order_items ri ON ri.return_order_id = t.id JOIN sales_order_items si ON si.id = ri.sales_item_id
      WHERE t.biz_date BETWEEN ${r.gte} AND ${r.lte} AND t.store_id = ANY(${ids}) GROUP BY 1`,
    db.$queryRaw<{ store_id: number; v: bigint }[]>`SELECT store_id, SUM(expected_commission_fen)::bigint AS v FROM carrier_business WHERE status NOT IN ('VOIDED', 'FAILED') AND biz_date BETWEEN ${r.gte} AND ${r.lte} AND store_id = ANY(${ids}) GROUP BY 1`,
    db.$queryRaw<{ store_id: number; charge: bigint; cost: bigint }[]>`SELECT store_id, SUM(charge_fen)::bigint AS charge, SUM(COALESCE(cost_fen, 0))::bigint AS cost FROM repair_orders WHERE status = 'CLOSED' AND biz_date BETWEEN ${r.gte} AND ${r.lte} AND store_id = ANY(${ids}) GROUP BY 1`,
    // 国补驳回：按驳回那天（北京时间）算进那个月；时间列存的是 UTC，加 8 小时是北京时间
    db.$queryRaw<{ store_id: number; v: bigint }[]>`SELECT store_id, SUM(subsidy_fen)::bigint AS v FROM subsidy_claims WHERE status = 'REJECTED' AND (reviewed_at + interval '8 hours')::date BETWEEN ${r.gte} AND ${r.lte} AND store_id = ANY(${ids}) GROUP BY 1`,
  ]);
  const get = <T extends { store_id: number }>(rows: T[], id: number) => rows.find((x) => x.store_id === id);
  return new Map(
    ids.map((id) => [
      id,
      {
        salesFen: n(get(sales, id)?.v) - n(get(returns, id)?.refund),
        goodsCostFen: n(get(goodsCost, id)?.v) - n(get(returns, id)?.cost),
        carrierFen: n(get(carrier, id)?.v),
        repairFen: n(get(repair, id)?.charge),
        repairCostFen: n(get(repair, id)?.cost),
        subsidyLossFen: n(get(subsidyLoss, id)?.v),
      },
    ]),
  );
}

export async function getPnl(user: CurrentUser, query: { month?: string; storeId?: number }, now = new Date(), db: Db = prisma) {
  if (user.role === "STAFF") throw new PnlError("利润表店长、区域经理和总部能看");
  const thisMonth = bjDateKey(now).slice(0, 7);
  const [y, m] = thisMonth.split("-").map(Number) as [number, number];
  const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const month = isMonthKey(query.month) && query.month <= thisMonth ? query.month : lastMonth;
  const scoped = await db.store.findMany({ where: storeTableWhere(user), orderBy: { code: "asc" }, select: { id: true, code: true, name: true, regionId: true, isActive: true } });
  const [revenue, expenses, payroll, fixedRows] = await Promise.all([
    storeRevenue(db, month, scoped.map((s) => s.id)),
    paidExpensesByStore(db, month),
    payrollCostByStore(db, month),
    db.storeFixedExpense.findMany({ where: { month, storeId: { in: scoped.map((s) => s.id) } }, select: { storeId: true, category: true, amountFen: true, note: true } }),
  ]);
  // 停用的店这个月有数据（销售、运营商、维修、国补驳回、报销、工资、固定支出任何一样）就照样列出来，合计才和工资总额、看板对得上
  const hasData = (id: number) => Object.values(revenue.get(id)!).some((v) => v !== 0) || (expenses.get(id) ?? 0) !== 0 || (payroll.byStore.get(id) ?? 0) !== 0 || fixedRows.some((f) => f.storeId === id);
  const allStores = scoped.filter((s) => s.isActive || hasData(s.id));
  const label = (s: (typeof scoped)[number]) => `${s.code} ${s.name}${s.isActive ? "" : "（已停用）"}`;
  const storeId = query.storeId && allStores.some((s) => s.id === query.storeId) ? query.storeId : null;
  const stores = storeId ? allStores.filter((s) => s.id === storeId) : allStores;
  const rows = stores.map((s) => {
    const fixed = fixedRows.filter((f) => f.storeId === s.id);
    const numbers = computePnl({
      ...revenue.get(s.id)!,
      expenseFen: expenses.get(s.id) ?? 0,
      payrollFen: payroll.byStore.get(s.id) ?? 0,
      fixedFen: fixed.reduce((sum, f) => sum + f.amountFen, 0),
      payrollPublished: payroll.published,
      fixedEntered: fixed.length > 0 || !s.isActive, // 停用的店录不了，不再标“固定支出没录”
    });
    return {
      key: `store:${s.id}`,
      storeId: s.id,
      name: label(s),
      inactive: !s.isActive,
      numbers,
      fixed: Object.fromEntries(fixed.map((f) => [f.category, { amountFen: f.amountFen, note: f.note }])) as Partial<Record<FixedExpenseCategoryKey, { amountFen: number; note: string | null }>>,
      canEdit: s.isActive && canEditFixed(user, s.id) && month <= thisMonth,
    };
  });
  // 总部自己的报销、没门店的人的工资：只有总部看全部门店时单列一行，算进合计
  const hqRow =
    user.role === "HQ" && !storeId
      ? {
          key: "hq",
          storeId: null,
          name: "总部（不挂门店的报销、工资）",
          inactive: false,
          numbers: computePnl({ salesFen: 0, carrierFen: 0, repairFen: 0, goodsCostFen: 0, repairCostFen: 0, expenseFen: expenses.get(null) ?? 0, payrollFen: payroll.byStore.get(null) ?? 0, fixedFen: 0, subsidyLossFen: 0, payrollPublished: payroll.published, fixedEntered: true }),
          fixed: {},
          canEdit: false,
        }
      : null;
  const all = [...rows, ...(hqRow ? [hqRow] : [])];
  return {
    month,
    thisMonth,
    stores: allStores.map((s) => ({ id: s.id, label: label(s) })),
    storeId,
    rows: all,
    total: all.length > 1 ? sumPnl(all.map((r) => r.numbers)) : null,
    payrollPublished: payroll.published,
  };
}

export type PnlPage = Awaited<ReturnType<typeof getPnl>>;
export type PnlRow = PnlPage["rows"][number];
export type { PnlNumbers };

/** 录一家店一个月的固定支出（房租、水电、物业、其他）：录了 0 也算录了；改的时候日志记原来 → 改成 */
export async function saveFixedExpenses(user: CurrentUser, input: { storeId: unknown; month: unknown; items: unknown }, opts: { db?: Db; now?: Date } = {}) {
  const storeId = Number(input.storeId);
  if (!isDbId(storeId)) throw new PnlError("门店不对");
  if (!canEditFixed(user, storeId)) throw new PnlError("固定支出店长（本店）和总部能录");
  if (!isMonthKey(input.month)) throw new PnlError("月份不对");
  const month = input.month;
  if (month > bjDateKey(opts.now ?? new Date()).slice(0, 7)) throw new PnlError("还没到的月份不能录");
  if (!Array.isArray(input.items) || input.items.length === 0) throw new PnlError("没有要保存的");
  const items = (input.items as { category?: unknown; amountFen?: unknown; note?: unknown }[]).map((it) => {
    const category = it?.category as FixedExpenseCategoryKey;
    if (!FIXED_EXPENSE_CATEGORIES.includes(category)) throw new PnlError("支出类别不对");
    const amountFen = Number(it?.amountFen);
    if (!Number.isInteger(amountFen) || amountFen < 0 || amountFen > MAX_FIXED_FEN) throw new PnlError(`${FIXED_EXPENSE_LABELS[category]}填 0～10 万元，最小到分`);
    return { category, amountFen, note: typeof it?.note === "string" ? it.note.trim().slice(0, 50) || null : null };
  });
  if (new Set(items.map((i) => i.category)).size !== items.length) throw new PnlError("同一类填了两次");
  return withTx(opts.db ?? prisma, async (tx) => {
    const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true, isActive: true } });
    if (!store || !store.isActive || !canAccessStoreSafe(user, store)) throw new PnlError("门店不存在或不在你的范围内");
    const before = await tx.storeFixedExpense.findMany({ where: { storeId, month }, select: { category: true, amountFen: true } });
    for (const it of items) {
      await tx.storeFixedExpense.upsert({ where: { storeId_month_category: { storeId, month, category: it.category } }, create: { storeId, month, ...it, updatedById: user.id }, update: { amountFen: it.amountFen, note: it.note, updatedById: user.id } });
    }
    await writeAudit({ userId: user.id, action: "pnl.fixed.save", entity: "store", entityId: storeId, detail: { month, before: Object.fromEntries(before.map((b) => [b.category, b.amountFen])), after: Object.fromEntries(items.map((i) => [i.category, i.amountFen])) } }, tx);
  });
}
