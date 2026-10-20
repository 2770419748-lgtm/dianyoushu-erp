import type { PaymentMethod } from "@/generated/prisma/enums";

// 日结对账的纯函数（口径第 5 节"日结"），不查库，方便单元测试。

export const DAILY_CLOSE_METHODS: PaymentMethod[] = ["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER", "TRADE_IN", "SUBSIDY"];

/** 不用店长手点的方式：以旧换新抵扣、国补立减都不是门店当天收到的钱，实收自动等于系统数 */
export const AUTO_MATCH_METHODS: PaymentMethod[] = ["TRADE_IN", "SUBSIDY"];

export type MethodAmounts = Record<PaymentMethod, number>;

export function emptyAmounts(): MethodAmounts {
  return { CASH: 0, WECHAT: 0, ALIPAY: 0, CARD: 0, INSTALLMENT: 0, OTHER: 0, TRADE_IN: 0, SUBSIDY: 0 };
}

/** 按支付方式汇总：收款正、退款负 */
export function summarizeByMethod(payments: { method: PaymentMethod; amountFen: number }[]): MethodAmounts {
  const sum = emptyAmounts();
  for (const p of payments) sum[p.method] += p.amountFen;
  return sum;
}

export interface CloseLine {
  method: PaymentMethod;
  systemFen: number;
  actualFen: number | null; // 店长录入；null = 还没录
  diffFen: number | null; // 实收 − 系统
}

/** 生成日结明细：系统数 vs 实收，差异 = 实收 − 系统；抵扣行自动对平 */
export function buildCloseLines(system: MethodAmounts, actual: Partial<Record<PaymentMethod, number | null>>): CloseLine[] {
  return DAILY_CLOSE_METHODS.map((method) => {
    const systemFen = system[method];
    const raw = AUTO_MATCH_METHODS.includes(method) ? systemFen : actual[method];
    const actualFen = raw === undefined || raw === null ? (systemFen === 0 ? 0 : null) : raw;
    return { method, systemFen, actualFen, diffFen: actualFen === null ? null : actualFen - systemFen };
  });
}

/** 一张销售单的收款合计和应收对不对得上（逐笔比对用） */
export function orderMismatchFen(totalFen: number, payments: { amountFen: number }[]): number {
  return payments.reduce((s, p) => s + p.amountFen, 0) - totalFen;
}

export interface CloseCheck {
  ok: boolean;
  missing: PaymentMethod[]; // 系统有数但没录实收的方式
  diffs: { method: PaymentMethod; diffFen: number }[]; // 有差异的方式
  mismatchedOrders: number; // 收款合计 ≠ 应收的单数
}

/** 能不能确认：每种有数的方式都录了实收；差异可以有（会标红留痕），但订单收款对不上的必须先处理 */
export function checkClose(lines: CloseLine[], mismatchedOrders: number): CloseCheck {
  const missing = lines.filter((l) => l.actualFen === null).map((l) => l.method);
  const diffs = lines.filter((l) => l.diffFen !== null && l.diffFen !== 0).map((l) => ({ method: l.method, diffFen: l.diffFen! }));
  return { ok: missing.length === 0 && mismatchedOrders === 0, missing, diffs, mismatchedOrders };
}
