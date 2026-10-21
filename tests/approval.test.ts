import { describe, expect, it } from "vitest";
import { canDecide, decideApproval, nextApprovalStep, type ApprovalRuleConfig } from "@/lib/approval";

// 审批规则怎么判断（口径第 17 节）。纯函数，不连库。

const rule = (kind: ApprovalRuleConfig["kind"], extra: Partial<ApprovalRuleConfig> = {}): ApprovalRuleConfig => ({ kind, enabled: true, thresholdFen: null, thresholdBp: null, approverRole: "STORE_MANAGER", ...extra });

describe("要不要审批", () => {
  it("规则关着、没达到门槛都不用批", () => {
    const facts = { action: "SALE" as const, listFen: 300000, totalFen: 270000, belowCostCount: 0 };
    expect(decideApproval([rule("SALE_DISCOUNT", { enabled: false, thresholdBp: 500 })], facts, "STAFF").required).toBe(false);
    expect(decideApproval([rule("SALE_DISCOUNT", { thresholdBp: 1500 })], facts, "STAFF").required).toBe(false);
    expect(decideApproval([], facts, "STAFF").required).toBe(false);
  });

  it("开单让利：金额或比例，达到任一个就要批；摘要写清楚让了多少", () => {
    const facts = { action: "SALE" as const, listFen: 300000, totalFen: 270000, belowCostCount: 0 };
    const byPct = decideApproval([rule("SALE_DISCOUNT", { thresholdBp: 500 })], facts, "STAFF");
    expect(byPct).toMatchObject({ required: true, approverRole: "STORE_MANAGER", amountFen: 30000 });
    expect(byPct.reasons[0]!.text).toContain("让利 300 元，占原价 10.0%，超过了 5%");
    expect(decideApproval([rule("SALE_DISCOUNT", { thresholdFen: 30000, thresholdBp: 5000 })], facts, "STAFF").required).toBe(true);
    expect(decideApproval([rule("SALE_DISCOUNT", { thresholdFen: 30001 })], facts, "STAFF").required).toBe(false);
  });

  it("店长自己做、规则写店长批：不用批；规则写总部批：店长也要批；总部做的都不用批", () => {
    const facts = { action: "SALE" as const, listFen: 300000, totalFen: 200000, belowCostCount: 0 };
    expect(decideApproval([rule("SALE_DISCOUNT", { thresholdBp: 500 })], facts, "STORE_MANAGER").required).toBe(false);
    expect(decideApproval([rule("SALE_DISCOUNT", { thresholdBp: 500, approverRole: "HQ" })], facts, "STORE_MANAGER")).toMatchObject({ required: true, approverRole: "HQ" });
    expect(decideApproval([rule("SALE_DISCOUNT", { thresholdBp: 500, approverRole: "HQ" })], facts, "HQ").required).toBe(false);
  });

  it("几条都触发合成一张，审批人取最高的；不管这件事的规则不算", () => {
    const facts = { action: "SALE" as const, listFen: 300000, totalFen: 200000, belowCostCount: 1 };
    const d = decideApproval([rule("SALE_DISCOUNT", { thresholdBp: 500 }), rule("SALE_BELOW_COST", { approverRole: "HQ" }), rule("RETURN_REFUND", { thresholdFen: 1 })], facts, "STAFF");
    expect(d.approverRole).toBe("HQ");
    expect(d.reasons.map((r) => r.kind)).toEqual(["SALE_DISCOUNT", "SALE_BELOW_COST"]);
  });

  it("退款、作废、调拨、盘亏按金额门槛；作废门槛 0 就是都要批", () => {
    expect(decideApproval([rule("RETURN_REFUND", { thresholdFen: 300000 })], { action: "RETURN", refundFen: 299999 }, "STAFF").required).toBe(false);
    expect(decideApproval([rule("RETURN_REFUND", { thresholdFen: 300000 })], { action: "RETURN", refundFen: 300000 }, "STAFF").required).toBe(true);
    expect(decideApproval([rule("SALE_VOID", { thresholdFen: 0, approverRole: "HQ" })], { action: "SALE_VOID", totalFen: 100 }, "STORE_MANAGER").reasons[0]!.text).toBe("作废销售单都要批");
    expect(decideApproval([rule("TRANSFER", { thresholdFen: 2000000, approverRole: "HQ" })], { action: "TRANSFER", costFen: 2100000 }, "STORE_MANAGER").required).toBe(true);
    expect(decideApproval([rule("STOCKTAKE_LOSS", { thresholdFen: 50000, approverRole: "HQ" })], { action: "STOCKTAKE", lossCostFen: 0 }, "STORE_MANAGER").required).toBe(false);
  });
});

describe("谁能批", () => {
  it("店长批的：店长和总部都能批；总部批的只有总部；不能批自己发起的", () => {
    expect(canDecide("STORE_MANAGER", "STORE_MANAGER", false)).toBe(true);
    expect(canDecide("STORE_MANAGER", "HQ", false)).toBe(true);
    expect(canDecide("HQ", "STORE_MANAGER", false)).toBe(false);
    expect(canDecide("STORE_MANAGER", "STAFF", false)).toBe(false);
    expect(canDecide("STORE_MANAGER", "REGIONAL_MANAGER", false)).toBe(false);
    expect(canDecide("HQ", "HQ", true)).toBe(false);
  });
});

describe("两级审批（口径第 19 节）", () => {
  it("店长批完转总部；总部批的就是最后一级；只有一级的批了就生效", () => {
    expect(nextApprovalStep(["STORE_MANAGER", "HQ"], 1, "STORE_MANAGER")).toEqual({ step: 2, role: "HQ" });
    expect(nextApprovalStep(["STORE_MANAGER", "HQ"], 1, "HQ")).toBeNull(); // 总部直接批了第一级，后面不用再批
    expect(nextApprovalStep(["STORE_MANAGER", "HQ"], 2, "HQ")).toBeNull();
    expect(nextApprovalStep(["STORE_MANAGER"], 1, "STORE_MANAGER")).toBeNull();
    expect(nextApprovalStep(["HQ"], 1, "HQ")).toBeNull();
    expect(nextApprovalStep([], 1, "STORE_MANAGER")).toBeNull(); // 第 17 节的审批单没有审批链
  });

  it("前一级批过的人不能再批后一级", () => {
    expect(canDecide("HQ", "HQ", false, true)).toBe(false);
    expect(canDecide("HQ", "HQ", false, false)).toBe(true);
  });
});
