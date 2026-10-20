import { describe, expect, it } from "vitest";
import { isSettleableMonth, monthRange, parseStatementCsv, reconcileStatement, statementToCsv, StatementParseError, type ReconcileCandidate, type StatementLine } from "@/lib/carrier";

// 运营商业务（口径第 14 节）：结算月份、结算单 CSV 解析、按月对账。纯函数，不连库。

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("运营商结算月份", () => {
  it("只能对已经过完的月份，格式 YYYY-MM", () => {
    const today = d("2026-10-20");
    expect(isSettleableMonth("2026-09", today)).toBe(true);
    expect(isSettleableMonth("2025-12", today)).toBe(true);
    expect(isSettleableMonth("2026-10", today)).toBe(false);
    expect(isSettleableMonth("2026-11", today)).toBe(false);
    expect(isSettleableMonth("2026-9", today)).toBe(false);
    expect(isSettleableMonth("2026-13", today)).toBe(false);
  });

  it("月份范围是当月 1 号到下月 1 号（跨年也对）", () => {
    expect(monthRange("2026-12")).toEqual({ from: d("2026-12-01"), to: d("2027-01-01") });
  });
});

describe("结算单 CSV", () => {
  it("表头带“（元）”、列顺序不同、有 BOM 和引号都能读；业务类型、返销可以空", () => {
    const csv = "﻿办理号码,佣金（元）,受理单号,业务类型,返销（元）\r\n13800001111,80,CM001,新号入网,0\r\n\"13900002222\",\"120.50\",,宽带,\r\n13700003333,0,CM003,,150\r\n";
    expect(parseStatementCsv(csv)).toEqual([
      { carrierOrderNo: "CM001", phone: "13800001111", bizType: "NEW_LINE", commissionFen: 8000, clawbackFen: 0 },
      { carrierOrderNo: null, phone: "13900002222", bizType: "BROADBAND", commissionFen: 12050, clawbackFen: 0 },
      { carrierOrderNo: "CM003", phone: "13700003333", bizType: null, commissionFen: 0, clawbackFen: 15000 },
    ]);
  });

  it("只有受理单号列、没有号码列也行", () => {
    expect(parseStatementCsv("受理单号,佣金\nCT9,25")).toEqual([{ carrierOrderNo: "CT9", phone: null, bizType: null, commissionFen: 2500, clawbackFen: 0 }]);
  });

  it("读不了的说清楚是哪一行、哪里不对", () => {
    expect(() => parseStatementCsv("受理单号,佣金")).toThrow(StatementParseError);
    expect(() => parseStatementCsv("受理单号,金额\nA1,10")).toThrow("表头要有“佣金”");
    expect(() => parseStatementCsv("受理单号,佣金\nA1,十元")).toThrow("第 2 行的佣金");
    expect(() => parseStatementCsv("受理单号,佣金\nA1,-5")).toThrow("不是金额");
    expect(() => parseStatementCsv("受理单号,佣金\nA1,1.234")).toThrow("不是金额");
    expect(() => parseStatementCsv("受理单号,办理号码,佣金\n,,10")).toThrow("第 2 行没有受理单号也没有号码");
    expect(() => parseStatementCsv("受理单号,业务类型,佣金\nA1,靓号,10")).toThrow("业务类型“靓号”不认识");
  });

  it("生成的 CSV 能原样读回来", () => {
    const lines: StatementLine[] = [
      { carrierOrderNo: "CM1", phone: "13800001111", bizType: "CONTRACT_PHONE", commissionFen: 20000, clawbackFen: 0 },
      { carrierOrderNo: null, phone: "13900002222", bizType: null, commissionFen: 0, clawbackFen: 7005 },
    ];
    expect(parseStatementCsv(statementToCsv(lines))).toEqual(lines);
  });
});

describe("按月对账", () => {
  const c = (id: number, extra: Partial<ReconcileCandidate> = {}): ReconcileCandidate => ({ id, carrierOrderNo: `CM${id}`, phone: `1380000000${id}`, bizType: "NEW_LINE", expectedCommissionFen: 8000, status: "ACTIVATED", inMonth: true, ...extra });
  const line = (extra: Partial<StatementLine>): StatementLine => ({ carrierOrderNo: null, phone: null, bizType: null, commissionFen: 8000, clawbackFen: 0, ...extra });

  it("先按受理单号对；金额一样记对上，不一样记金额不符，照运营商给的记实收", () => {
    const r = reconcileStatement([line({ carrierOrderNo: "CM1" }), line({ carrierOrderNo: "CM2", commissionFen: 7000 })], [c(1), c(2)]);
    expect(r.lines.map((l) => [l.businessId, l.result])).toEqual([[1, "MATCHED"], [2, "DIFF"]]);
    expect(r.settle).toEqual([{ id: 1, settledFen: 8000 }, { id: 2, settledFen: 7000 }]);
    expect(r.missing).toEqual([]);
  });

  it("没有受理单号的按号码 + 业务类型对，同号码优先对这个月的", () => {
    const old = c(1, { carrierOrderNo: null, phone: "13811112222", inMonth: false });
    const now = c(2, { carrierOrderNo: null, phone: "13811112222" });
    const broadband = c(3, { carrierOrderNo: null, phone: "13811112222", bizType: "BROADBAND" });
    const r = reconcileStatement([line({ phone: "13811112222", bizType: "NEW_LINE" })], [old, now, broadband]);
    expect(r.lines[0]).toMatchObject({ businessId: 2, result: "MATCHED" });
    expect(r.missing).toEqual([3]); // 宽带那笔这个月没给
  });

  it("一笔业务只对一行：重复的行、对不上的行记“我们没登记”；给佣金的不对已结算的", () => {
    const r = reconcileStatement([line({ carrierOrderNo: "CM1" }), line({ carrierOrderNo: "CM1" }), line({ carrierOrderNo: "XX9" }), line({ carrierOrderNo: "CM2" })], [c(1), c(2, { status: "SETTLED", inMonth: false })]);
    expect(r.lines.map((l) => l.result)).toEqual(["MATCHED", "UNMATCHED", "UNMATCHED", "UNMATCHED"]);
    expect(r.settle).toEqual([{ id: 1, settledFen: 8000 }]);
  });

  it("返销的行可以对以前月份已结算的，记扣回；没结算过的也能扣", () => {
    const r = reconcileStatement(
      [line({ carrierOrderNo: "CM1", commissionFen: 0, clawbackFen: 8000 }), line({ phone: "13800000002", commissionFen: 0, clawbackFen: 5000 })],
      [c(1, { status: "SETTLED", inMonth: false }), c(2, { inMonth: false })],
    );
    expect(r.lines.map((l) => [l.businessId, l.result])).toEqual([[1, "MATCHED"], [2, "MATCHED"]]);
    expect(r.clawback).toEqual([{ id: 1, clawbackFen: 8000 }, { id: 2, clawbackFen: 5000 }]);
    expect(r.settle).toEqual([]);
    expect(r.missing).toEqual([]); // 以前月份的不算这个月漏给
  });

  it("这个月已开通、结算单里没有的记漏给；以前月份、已结算的不算", () => {
    const r = reconcileStatement([], [c(1), c(2, { inMonth: false }), c(3, { status: "SETTLED" })]);
    expect(r.missing).toEqual([1]);
  });
});
