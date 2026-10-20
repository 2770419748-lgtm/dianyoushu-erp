import { describe, expect, it } from "vitest";
import { applyPlatformResult, lineBaseFen, normalizeQualificationCode, parsePlatformResultCsv, planSubsidy, platformResultToCsv, policyInEffect, simulateVerifyQualification, subsidyFenOf, SubsidyParseError, type SubsidyPolicyRule } from "@/lib/subsidy";
import { buildSalePayments, maxRefundableFen, returnRefundCapFen } from "@/server/sales/payments";

// 国补（口径第 15 节）：算补贴、挑哪台、资格码、平台结果表格、收款和退款里的国补。纯函数，不连库。

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const phone: SubsidyPolicyRule = { id: 1, categoryId: 10, categoryName: "手机", rateBp: 1500, capFen: 50000, priceCapFen: 600000, startsOn: d("2026-01-01"), endsOn: d("2026-12-31"), isActive: true };
const pad: SubsidyPolicyRule = { ...phone, id: 2, categoryId: 11, categoryName: "平板" };
const today = d("2026-10-20");

describe("国补：算补贴", () => {
  it("成交价 × 15%，四舍五入到分，单件最多 500 元", () => {
    expect(subsidyFenOf(269900, phone)).toBe(40485);
    expect(subsidyFenOf(549900, phone)).toBe(50000);
    expect(subsidyFenOf(333, phone)).toBe(50);
  });

  it("政策只在生效期内、在用时算数（起止日都含）", () => {
    expect(policyInEffect(phone, d("2026-01-01"))).toBe(true);
    expect(policyInEffect(phone, d("2026-12-31"))).toBe(true);
    expect(policyInEffect(phone, d("2027-01-01"))).toBe(false);
    expect(policyInEffect({ ...phone, isActive: false }, today)).toBe(false);
  });

  it("成交价按整单优惠比例分摊", () => {
    expect(lineBaseFen(600000, 610000, 600000)).toBe(590164);
    expect(lineBaseFen(100, 0, 0)).toBe(0);
  });

  it("一个资格码补一台：多台里挑补贴最多的；超过 6000 元的、用过这一类的、没有政策的品类都不补", () => {
    const plan = planSubsidy([{ key: 0, categoryId: 10, baseFen: 199900 }, { key: 1, categoryId: 10, baseFen: 399900 }, { key: 2, categoryId: 11, baseFen: 299900 }, { key: 3, categoryId: 99, baseFen: 9900 }], [phone, pad], new Set(), today);
    expect(plan.picks).toEqual([{ key: 1, policyId: 1, categoryId: 10, baseFen: 399900, subsidyFen: 50000 }]);
    expect(plan.notes.join()).toContain("一个资格码只补一台");

    const tooExpensive = planSubsidy([{ key: 0, categoryId: 10, baseFen: 649900 }], [phone], new Set(), today);
    expect(tooExpensive.picks).toEqual([]);
    expect(tooExpensive.notes[0]).toContain("超过 6000 元");

    const used = planSubsidy([{ key: 0, categoryId: 10, baseFen: 299900 }, { key: 1, categoryId: 11, baseFen: 199900 }], [phone, pad], new Set([10]), today);
    expect(used.picks.map((p) => p.key)).toEqual([1]); // 手机用过了，平板还能补
    expect(used.notes[0]).toContain("已经用过一次手机国补");

    expect(planSubsidy([{ key: 0, categoryId: 10, baseFen: 299900 }], [phone], new Set(), d("2027-03-01")).picks).toEqual([]); // 政策过期
  });
});

describe("国补：资格码、平台结果", () => {
  it("资格码转大写、字母数字 8～32 位；演示里尾号 0000 的当作过期", () => {
    expect(normalizeQualificationCode(" gb2026abc1 ")).toBe("GB2026ABC1");
    expect(normalizeQualificationCode("短码")).toBeNull();
    expect(normalizeQualificationCode("GB-2026-0001")).toBeNull();
    expect(simulateVerifyQualification("GB20261020001")).toEqual({ ok: true });
    expect(simulateVerifyQualification("GB2026102000000")).toMatchObject({ ok: false });
  });

  it("结果表格：表头带（元）、顺序不限、有 BOM；结果认通过、驳回、已到账；生成的能读回来", () => {
    const lines = parsePlatformResultCsv("﻿结果,核销码,原因,金额（元）\r\n通过,gb20261020001,,\r\n驳回,GB20261020002,串号照片看不清,\r\n已到账,GB20261020003,,404.85\r\n");
    expect(lines).toEqual([
      { code: "GB20261020001", result: "APPROVED", amountFen: 0, reason: null },
      { code: "GB20261020002", result: "REJECTED", amountFen: 0, reason: "串号照片看不清" },
      { code: "GB20261020003", result: "SETTLED", amountFen: 40485, reason: null },
    ]);
    expect(parsePlatformResultCsv(platformResultToCsv(lines))).toEqual(lines.map((l) => ({ ...l, reason: l.reason })));
    expect(() => parsePlatformResultCsv("核销码,金额\nGB20261020001,1")).toThrow(SubsidyParseError);
    expect(() => parsePlatformResultCsv("核销码,结果\nGB20261020001,退回")).toThrow("不认识");
    expect(() => parsePlatformResultCsv("核销码,结果,金额\nGB20261020001,已到账,-1")).toThrow("金额");
  });

  it("平台结果按状态落：审核中能通过或驳回、待到账能到账或驳回，其余不处理", () => {
    expect(applyPlatformResult("SUBMITTED", "APPROVED")).toEqual({ next: "APPROVED" });
    expect(applyPlatformResult("SUBMITTED", "SETTLED")).toEqual({ next: "SETTLED" });
    expect(applyPlatformResult("APPROVED", "REJECTED")).toEqual({ next: "REJECTED" });
    expect(applyPlatformResult("PENDING", "SETTLED")).toHaveProperty("skip");
    expect(applyPlatformResult("CANCELLED", "APPROVED")).toHaveProperty("skip");
    expect(applyPlatformResult("SETTLED", "SETTLED")).toHaveProperty("skip");
  });
});

describe("国补：收款和退款", () => {
  it("收款 = 以旧换新抵扣 + 国补立减 + 顾客付的，国补不能手选", () => {
    expect(buildSalePayments(269900, 50000, [{ method: "WECHAT", amountFen: 179415 }], 40485)).toEqual([
      { method: "TRADE_IN", amountFen: 50000 },
      { method: "SUBSIDY", amountFen: 40485 },
      { method: "WECHAT", amountFen: 179415 },
    ]);
    expect(() => buildSalePayments(269900, 0, [{ method: "SUBSIDY", amountFen: 269900 }])).toThrow("收款方式不对");
    expect(() => buildSalePayments(100000, 60000, [], 50000)).toThrow("超过了应收");
  });

  it("退货：国补部分不退给顾客，退款上限扣掉这台的补贴", () => {
    const payments = [
      { method: "SUBSIDY" as const, amountFen: 40485 },
      { method: "WECHAT" as const, amountFen: 229415 },
    ];
    expect(maxRefundableFen(payments, 0)).toBe(229415);
    expect(returnRefundCapFen([{ lineTotalFen: 269900, qty: 1, returnQty: 1, subsidyFen: 40485 }], { subtotalFen: 269900, totalFen: 269900 }, payments, 0)).toBe(229415);
  });
});
