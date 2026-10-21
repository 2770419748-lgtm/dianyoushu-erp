import { describe, expect, it } from "vitest";
import { computePnl, sumPnl } from "@/lib/pnl";

// 门店收支和利润表怎么拼（口径第 19 节）。纯函数，不连库。

const base = { salesFen: 1000000, carrierFen: 50000, repairFen: 30000, goodsCostFen: 800000, repairCostFen: 10000, expenseFen: 20000, payrollFen: 150000, fixedFen: 30000, payrollPublished: true, fixedEntered: true };

describe("一家店一个月", () => {
  it("收入 = 销售 + 运营商 + 维修；毛利 = 收入 − 销货成本；利润 = 毛利 − 报销 − 工资 − 固定支出", () => {
    const n = computePnl(base);
    expect(n).toMatchObject({ revenueFen: 1080000, costFen: 810000, grossFen: 270000, opexFen: 200000, profitFen: 70000, missing: [] });
    expect(n.grossRate).toBeCloseTo(0.25);
  });

  it("工资条没发布、固定支出没录：标数据不全；没收入就没有毛利率", () => {
    expect(computePnl({ ...base, payrollPublished: false, fixedEntered: false }).missing).toEqual(["工资条还没发布", "固定支出没录"]);
    expect(computePnl({ ...base, salesFen: 0, carrierFen: 0, repairFen: 0 }).grossRate).toBeNull();
  });

  it("合计：金额相加，数据不全的原因去重", () => {
    const a = computePnl(base);
    const b = computePnl({ ...base, fixedEntered: false, fixedFen: 0 });
    const t = sumPnl([a, b]);
    expect(t).toMatchObject({ salesFen: 2000000, fixedFen: 30000, profitFen: a.profitFen + b.profitFen, missing: ["固定支出没录"] });
  });
});
