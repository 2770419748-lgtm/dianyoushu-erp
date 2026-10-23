import { describe, expect, it } from "vitest";
import { buildSalePayments, maxRefundableFen, PaymentError, proportionalRefundFen } from "@/server/sales/payments";

describe("收款拆分：合计必须等于应收", () => {
  it("以旧换新抵扣 + 两种支付正好凑齐", () => {
    const lines = buildSalePayments(500000, 120000, [
      { method: "WECHAT", amountFen: 300000 },
      { method: "CASH", amountFen: 80000 },
    ]);
    expect(lines).toEqual([
      { method: "TRADE_IN", amountFen: 120000 },
      { method: "WECHAT", amountFen: 300000 },
      { method: "CASH", amountFen: 80000 },
    ]);
  });

  it("差一分、多一分都不行", () => {
    expect(() => buildSalePayments(500000, 0, [{ method: "WECHAT", amountFen: 499999 }])).toThrow(/还差 0.01 元/);
    expect(() => buildSalePayments(500000, 0, [{ method: "WECHAT", amountFen: 500001 }])).toThrow(/多收了 0.01 元/);
  });

  it("抵扣不能超过应收；抵扣正好等于应收时不用再收", () => {
    expect(() => buildSalePayments(100000, 120000, [])).toThrow(PaymentError);
    expect(buildSalePayments(100000, 100000, [])).toEqual([{ method: "TRADE_IN", amountFen: 100000 }]);
  });

  it("不能手选以旧换新抵扣；同一种方式不能分两笔；0 元的行忽略", () => {
    expect(() => buildSalePayments(1000, 0, [{ method: "TRADE_IN", amountFen: 1000 }])).toThrow(PaymentError);
    expect(() =>
      buildSalePayments(1000, 0, [
        { method: "CASH", amountFen: 500 },
        { method: "CASH", amountFen: 500 },
      ]),
    ).toThrow(/合并/);
    expect(buildSalePayments(1000, 0, [{ method: "CASH", amountFen: 1000 }, { method: "WECHAT", amountFen: 0 }])).toEqual([{ method: "CASH", amountFen: 1000 }]);
  });

  it("总部在系统设置里关掉的收款方式不能用（口径第 21 节）", () => {
    expect(() => buildSalePayments(1000, 0, [{ method: "CASH", amountFen: 1000 }], 0, ["WECHAT", "ALIPAY"])).toThrow(/没开/);
    expect(buildSalePayments(1000, 0, [{ method: "WECHAT", amountFen: 1000 }], 0, ["WECHAT", "ALIPAY"])).toEqual([{ method: "WECHAT", amountFen: 1000 }]);
  });
});

describe("退款", () => {
  it("默认退款按整单优惠比例分摊", () => {
    expect(proportionalRefundFen(549900, 552800, 550000)).toBe(547115);
    expect(proportionalRefundFen(2900, 2900, 2900)).toBe(2900);
  });

  it("最多退实付，抵扣部分不退，已退的扣掉", () => {
    const payments = [
      { method: "TRADE_IN" as const, amountFen: 120000 },
      { method: "WECHAT" as const, amountFen: 300000 },
      { method: "CASH" as const, amountFen: 80000 },
    ];
    expect(maxRefundableFen(payments, 0)).toBe(380000);
    expect(maxRefundableFen(payments, 100000)).toBe(280000);
    expect(maxRefundableFen(payments, 999999)).toBe(0);
  });
});
