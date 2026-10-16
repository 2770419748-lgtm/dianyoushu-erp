import { describe, expect, it } from "vitest";
import { buildCloseLines, checkClose, orderMismatchFen, summarizeByMethod } from "@/server/dailyclose/summary";

describe("日结汇总", () => {
  it("按支付方式汇总，退款记负", () => {
    const sum = summarizeByMethod([
      { method: "WECHAT", amountFen: 300000 },
      { method: "CASH", amountFen: 132800 },
      { method: "TRADE_IN", amountFen: 120000 },
      { method: "WECHAT", amountFen: 159900 },
      { method: "WECHAT", amountFen: -2900 }, // 退款
    ]);
    expect(sum.WECHAT).toBe(457000);
    expect(sum.CASH).toBe(132800);
    expect(sum.TRADE_IN).toBe(120000);
    expect(sum.ALIPAY).toBe(0);
  });

  it("差异 = 实收 − 系统；没数的方式自动对平；抵扣行自动等于系统数", () => {
    const system = summarizeByMethod([
      { method: "WECHAT", amountFen: 300000 },
      { method: "CASH", amountFen: 100000 },
      { method: "TRADE_IN", amountFen: 50000 },
    ]);
    const lines = buildCloseLines(system, { WECHAT: 300000, CASH: 99000 });
    const by = Object.fromEntries(lines.map((l) => [l.method, l]));
    expect(by.WECHAT!.diffFen).toBe(0);
    expect(by.CASH!.diffFen).toBe(-1000);
    expect(by.TRADE_IN!.actualFen).toBe(50000);
    expect(by.TRADE_IN!.diffFen).toBe(0);
    expect(by.ALIPAY!.actualFen).toBe(0);
  });

  it("有数的方式没录实收不能确认；订单收款对不上不能确认；差异可以有", () => {
    const system = summarizeByMethod([{ method: "CASH", amountFen: 100000 }]);
    expect(checkClose(buildCloseLines(system, {}), 0).ok).toBe(false);
    expect(checkClose(buildCloseLines(system, {}), 0).missing).toEqual(["CASH"]);
    expect(checkClose(buildCloseLines(system, { CASH: 100000 }), 1).ok).toBe(false);
    const withDiff = checkClose(buildCloseLines(system, { CASH: 99000 }), 0);
    expect(withDiff.ok).toBe(true);
    expect(withDiff.diffs).toEqual([{ method: "CASH", diffFen: -1000 }]);
  });

  it("逐笔比对：收款合计和应收的差", () => {
    expect(orderMismatchFen(502800, [{ amountFen: 120000 }, { amountFen: 300000 }, { amountFen: 82800 }])).toBe(0);
    expect(orderMismatchFen(502800, [{ amountFen: 500000 }])).toBe(-2800);
  });
});
