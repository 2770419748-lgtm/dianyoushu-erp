import { describe, expect, it } from "vitest";
import { dailyGap, sumByDate, timeProgress, turnoverDays } from "@/server/dashboard/metrics";

describe("看板指标", () => {
  it("时间进度按数据截止日：9 月 15 日 = 15 ÷ 30", () => {
    expect(timeProgress("2026-09-15")).toBe(0.5);
    expect(timeProgress("2026-10-31")).toBe(1);
  });

  it("门店日均差额 = 后面每天要卖的 − 现在的日均", () => {
    // 10 月目标 31 万，17 号已卖 15 万：日均 0.882 万；剩 14 天要卖 16 万 → 每天 1.143 万；差额 0.261 万
    const g = dailyGap(310000_00, 150000_00, "2026-10-17");
    expect(g.remainingDays).toBe(14);
    expect(Math.round(g.actualPerDay)).toBe(Math.round(150000_00 / 17));
    expect(Math.round(g.needPerDay)).toBe(Math.round(160000_00 / 14));
    expect(g.gap).toBeGreaterThan(0);
    // 已经超额：差额是负数
    expect(dailyGap(100_00, 200_00, "2026-10-17").gap).toBeLessThan(0);
  });

  it("周转天数 = 在库 ÷ 近 30 天日均销量；有货没卖过算滞销", () => {
    expect(turnoverDays(30, 60)).toBe(15);
    expect(turnoverDays(5, 0)).toBeNull();
    expect(turnoverDays(0, 0)).toBe(0);
  });

  it("按天合计多家店", () => {
    const m = sumByDate([
      { storeId: 1, date: "2026-10-16", sales: 100, profit: 10, orders: 1, devices: 1, tradeIns: 0 },
      { storeId: 2, date: "2026-10-16", sales: 200, profit: 30, orders: 2, devices: 1, tradeIns: 1 },
    ]);
    expect(m.get("2026-10-16")).toEqual({ sales: 300, profit: 40, orders: 3, devices: 2, tradeIns: 1 });
  });
});
