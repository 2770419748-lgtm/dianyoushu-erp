// 门店收支和利润表（口径第 19 节）：一家店一个月的收入、销货成本、毛利、费用、利润怎么拼，什么时候标“数据不全”。
// 纯函数，服务层、页面、单元测试共用（tests/pnl.test.ts）。数字由服务层从各张表查好传进来。

export type FixedExpenseCategoryKey = "RENT" | "UTILITIES" | "PROPERTY" | "OTHER";
export const FIXED_EXPENSE_CATEGORIES: FixedExpenseCategoryKey[] = ["RENT", "UTILITIES", "PROPERTY", "OTHER"];
export const FIXED_EXPENSE_LABELS: Record<FixedExpenseCategoryKey, string> = { RENT: "房租", UTILITIES: "水电", PROPERTY: "物业", OTHER: "其他" };

export interface PnlInput {
  salesFen: number; // 销售额：应收 − 退款（和看板同一个口径）
  carrierFen: number; // 运营商佣金：这个月办的、没作废没失败的业务按政策记的预计佣金
  repairFen: number; // 维修收费：这个月取机结算的
  goodsCostFen: number; // 卖出的机器、配件成本（退货冲回）
  repairCostFen: number; // 这个月结算的维修单的维修成本
  expenseFen: number; // 已付款的报销（按付款日期）
  payrollFen: number; // 这个月已发布工资条的应发，按那天在哪家店分过来的
  fixedFen: number; // 门店固定支出（房租、水电、物业……）
  payrollPublished: boolean; // 这个月的工资条发布了没有
  fixedEntered: boolean; // 这家店这个月录了固定支出没有（录了 0 也算录了）
}

export interface PnlNumbers extends PnlInput {
  revenueFen: number; // 收入 = 销售额 + 运营商佣金 + 维修收费
  costFen: number; // 销货成本 = 货品成本 + 维修成本
  grossFen: number; // 毛利 = 收入 − 销货成本
  grossRate: number | null; // 毛利率（收入为 0 时没有）
  opexFen: number; // 费用 = 报销 + 工资 + 固定支出
  profitFen: number; // 利润 = 毛利 − 费用
  missing: string[]; // 数据不全的原因
}

export function computePnl(input: PnlInput): PnlNumbers {
  const revenueFen = input.salesFen + input.carrierFen + input.repairFen;
  const costFen = input.goodsCostFen + input.repairCostFen;
  const grossFen = revenueFen - costFen;
  const opexFen = input.expenseFen + input.payrollFen + input.fixedFen;
  const missing = [...(input.payrollPublished ? [] : ["工资条还没发布"]), ...(input.fixedEntered ? [] : ["固定支出没录"])];
  return { ...input, revenueFen, costFen, grossFen, grossRate: revenueFen ? grossFen / revenueFen : null, opexFen, profitFen: grossFen - opexFen, missing };
}

/** 几家店加起来（合计行）：金额相加，数据不全的原因合并去重 */
export function sumPnl(rows: PnlNumbers[]): PnlNumbers {
  const keys = ["salesFen", "carrierFen", "repairFen", "goodsCostFen", "repairCostFen", "expenseFen", "payrollFen", "fixedFen"] as const;
  const total = Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)])) as Record<(typeof keys)[number], number>;
  const n = computePnl({ ...total, payrollPublished: rows.every((r) => r.payrollPublished), fixedEntered: rows.every((r) => r.fixedEntered) });
  return { ...n, missing: [...new Set(rows.flatMap((r) => r.missing))] };
}
