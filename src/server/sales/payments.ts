import type { PaymentMethod } from "@/generated/prisma/enums";

// 收款拆分与退款分摊的纯函数（口径第 6、7 节），不查库，方便单元测试。

export class PaymentError extends Error {}

/** 开单时能手工选的收款方式（以旧换新抵扣由回收单自动带出，不能手选） */
export const MANUAL_PAYMENT_METHODS: PaymentMethod[] = ["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER"];

export interface PaymentLine {
  method: PaymentMethod;
  amountFen: number;
}

/**
 * 校验一张销售单的收款：以旧换新抵扣 + 若干手工收款，合计必须正好等于应收，差一分都不行。
 * 返回要写进 payments 表的行（抵扣在前）。
 */
export function buildSalePayments(totalFen: number, tradeInFen: number, manual: { method: unknown; amountFen: unknown }[]): PaymentLine[] {
  if (!Number.isInteger(totalFen) || totalFen < 0) throw new PaymentError("应收金额不对");
  if (!Number.isInteger(tradeInFen) || tradeInFen < 0) throw new PaymentError("抵扣金额不对");
  if (tradeInFen > totalFen) throw new PaymentError(`以旧换新抵扣 ${tradeInFen / 100} 元超过了应收 ${totalFen / 100} 元`);

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

  const paid = tradeInFen + lines.reduce((s, l) => s + l.amountFen, 0);
  if (paid !== totalFen) {
    const diff = totalFen - paid;
    throw new PaymentError(diff > 0 ? `还差 ${(diff / 100).toFixed(2)} 元没收` : `多收了 ${(-diff / 100).toFixed(2)} 元`);
  }
  if (totalFen > 0 && lines.length === 0 && tradeInFen === 0) throw new PaymentError("请填收款");

  return tradeInFen > 0 ? [{ method: "TRADE_IN", amountFen: tradeInFen }, ...lines] : lines;
}

/**
 * 退货默认退多少：退回行的成交金额按整单优惠比例分摊（四舍五入到分）。
 * 例：商品合计 5528、优惠 28，退一行 5499 → 5499 × 5500 / 5528。
 */
export function proportionalRefundFen(lineFen: number, subtotalFen: number, totalFen: number): number {
  if (subtotalFen <= 0) return 0;
  return Math.round((lineFen * totalFen) / subtotalFen);
}

/**
 * 最多能退多少：实收（不含以旧换新抵扣）减去已经退过的。抵扣部分不退（旧机已回收）。
 */
export function maxRefundableFen(payments: PaymentLine[], alreadyRefundedFen: number): number {
  const paidCash = payments.filter((p) => p.method !== "TRADE_IN" && p.amountFen > 0).reduce((s, p) => s + p.amountFen, 0);
  return Math.max(0, paidCash - alreadyRefundedFen);
}
