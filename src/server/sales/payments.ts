import type { PaymentMethod } from "@/generated/prisma/enums";

// 收款拆分与退款分摊的纯函数（口径第 6、7 节），不查库，方便单元测试。

export class PaymentError extends Error {}

/** 开单时能手工选的收款方式（以旧换新抵扣由回收单自动带出、国补立减由系统按政策算，都不能手选） */
export const MANUAL_PAYMENT_METHODS: PaymentMethod[] = ["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER"];

export interface PaymentLine {
  method: PaymentMethod;
  amountFen: number;
}

/**
 * 校验一张销售单的收款：以旧换新抵扣 + 国补立减 + 若干手工收款，合计必须正好等于应收，差一分都不行。
 * 返回要写进 payments 表的行（抵扣、国补在前）。
 */
export function buildSalePayments(totalFen: number, tradeInFen: number, manual: { method: unknown; amountFen: unknown }[], subsidyFen = 0): PaymentLine[] {
  if (!Number.isInteger(totalFen) || totalFen < 0) throw new PaymentError("应收金额不对");
  if (!Number.isInteger(tradeInFen) || tradeInFen < 0) throw new PaymentError("抵扣金额不对");
  if (!Number.isInteger(subsidyFen) || subsidyFen < 0) throw new PaymentError("国补金额不对");
  if (tradeInFen > totalFen) throw new PaymentError(`以旧换新抵扣 ${tradeInFen / 100} 元超过了应收 ${totalFen / 100} 元`);
  if (tradeInFen + subsidyFen > totalFen) throw new PaymentError(`以旧换新抵扣加国补立减超过了应收 ${totalFen / 100} 元`);

  const seen = new Set<PaymentMethod>();
  const lines: PaymentLine[] = [];
  for (const [index, raw] of manual.entries()) {
    const method = raw.method as PaymentMethod;
    if (!MANUAL_PAYMENT_METHODS.includes(method)) throw new PaymentError(`第 ${index + 1} 笔收款方式不对`);
    const amountFen = Number(raw.amountFen);
    if (!Number.isInteger(amountFen) || amountFen < 0) throw new PaymentError(`第 ${index + 1} 笔金额不对`);
    if (amountFen === 0) continue;
    if (seen.has(method)) throw new PaymentError("同一种收款方式不要分两笔，合并成一笔");
    seen.add(method);
    lines.push({ method, amountFen });
  }

  const paid = tradeInFen + subsidyFen + lines.reduce((s, l) => s + l.amountFen, 0);
  if (paid !== totalFen) {
    const diff = totalFen - paid;
    throw new PaymentError(diff > 0 ? `还差 ${(diff / 100).toFixed(2)} 元没收` : `多收了 ${(-diff / 100).toFixed(2)} 元`);
  }
  if (totalFen > 0 && lines.length === 0 && tradeInFen === 0 && subsidyFen === 0) throw new PaymentError("请填收款");

  return [...(tradeInFen > 0 ? [{ method: "TRADE_IN" as const, amountFen: tradeInFen }] : []), ...(subsidyFen > 0 ? [{ method: "SUBSIDY" as const, amountFen: subsidyFen }] : []), ...lines];
}

/**
 * 退货默认退多少：退回行的成交金额按整单优惠比例分摊（四舍五入到分）。
 * 例：商品合计 5528、优惠 28，退一行 5499 → 5499 × 5500 / 5528。
 */
export function proportionalRefundFen(lineFen: number, subtotalFen: number, totalFen: number): number {
  if (subtotalFen <= 0) return 0;
  return Math.round((lineFen * totalFen) / subtotalFen);
}

/** 不退给顾客的收款：以旧换新抵扣（旧机已回收）、国补立减（平台出的钱，退货时撤销国补单） */
const NOT_REFUNDABLE: PaymentMethod[] = ["TRADE_IN", "SUBSIDY"];

/**
 * 最多能退多少：顾客实付（不含以旧换新抵扣、国补立减）减去已经退过的。
 */
export function maxRefundableFen(payments: PaymentLine[], alreadyRefundedFen: number): number {
  const paidCash = payments.filter((p) => !NOT_REFUNDABLE.includes(p.method) && p.amountFen > 0).reduce((s, p) => s + p.amountFen, 0);
  return Math.max(0, paidCash - alreadyRefundedFen);
}

/**
 * 这一次退货最多能退多少钱：只看这次退回的行。
 * 每行按退的件数取成交额，再按整单优惠比例分摊，减去这台机器的国补（平台出的，不退给顾客），加起来；
 * 同时不能超过“实付 − 已退”（抵扣、国补部分不退）。
 * 例：5258 元的单（机器 5199 + 配件 59）只退配件，最多退 59 元，不能把整单的钱退走。
 */
export function returnRefundCapFen(
  lines: { lineTotalFen: number; qty: number; returnQty: number; subsidyFen?: number }[],
  order: { subtotalFen: number; totalFen: number },
  payments: PaymentLine[],
  alreadyRefundedFen: number,
): number {
  const byLines = lines.reduce(
    (s, l) => s + (l.returnQty > 0 ? Math.max(0, proportionalRefundFen(Math.round((l.lineTotalFen * l.returnQty) / l.qty), order.subtotalFen, order.totalFen) - (l.subsidyFen ?? 0)) : 0),
    0,
  );
  return Math.min(byLines, maxRefundableFen(payments, alreadyRefundedFen));
}
