import { describe, expect, it } from "vitest";
import { addMonthsClamped, daysUntil, entitlementExpiresOn, entitlementPeriod, entitlementStateLabel, reminderStageFor, stageDateRange } from "@/lib/entitlement";

// 服务权益的日期规则（口径第 12 节）：到期日 = 生效日 + N 个月 − 1 天，目标月没有那一天取当月最后一天。
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);

describe("到期日计算", () => {
  it("普通日期：保 12 个月，到第二年前一天", () => {
    expect(ymd(entitlementExpiresOn(d("2026-10-20"), 12))).toBe("2027-10-19");
    expect(ymd(entitlementExpiresOn(d("2026-01-15"), 12))).toBe("2027-01-14");
  });

  it("跨年和季度版", () => {
    expect(ymd(entitlementExpiresOn(d("2026-11-30"), 3))).toBe("2027-02-27"); // 2 月没有 30 日 → 2 月 28 日再减一天
    expect(ymd(entitlementExpiresOn(d("2026-12-01"), 1))).toBe("2026-12-31");
  });

  it("月底：目标月没有这一天就取当月最后一天", () => {
    expect(ymd(addMonthsClamped(d("2026-01-31"), 1))).toBe("2026-02-28");
    expect(ymd(entitlementExpiresOn(d("2026-01-31"), 1))).toBe("2026-02-27");
    expect(ymd(addMonthsClamped(d("2026-03-31"), 1))).toBe("2026-04-30");
  });

  it("闰年 2 月", () => {
    expect(ymd(addMonthsClamped(d("2028-01-31"), 1))).toBe("2028-02-29");
    expect(ymd(entitlementExpiresOn(d("2028-02-29"), 12))).toBe("2029-02-27"); // 2029-02-28 再减一天
    expect(ymd(entitlementExpiresOn(d("2027-03-01"), 12))).toBe("2028-02-29");
  });

  it("期限必须是正整数个月", () => {
    expect(() => entitlementExpiresOn(d("2026-10-20"), 0)).toThrow();
    expect(() => entitlementExpiresOn(d("2026-10-20"), 1.5)).toThrow();
  });
});

describe("剩余天数与提醒档位", () => {
  it("到期当天剩 0 天，过期是负数", () => {
    expect(daysUntil(d("2026-10-20"), d("2026-10-20"))).toBe(0);
    expect(daysUntil(d("2026-10-27"), d("2026-10-20"))).toBe(7);
    expect(daysUntil(d("2026-10-19"), d("2026-10-20"))).toBe(-1);
  });

  it("剩 8～30 天一档，剩 0～7 天一档，其他不提醒", () => {
    expect(reminderStageFor(31)).toBeNull();
    expect(reminderStageFor(30)).toBe("T30");
    expect(reminderStageFor(8)).toBe("T30");
    expect(reminderStageFor(7)).toBe("T7");
    expect(reminderStageFor(0)).toBe("T7");
    expect(reminderStageFor(-1)).toBeNull();
  });

  it("档位的到期日区间", () => {
    const today = d("2026-10-20");
    expect(stageDateRange("T7", today)).toEqual({ from: d("2026-10-20"), to: d("2026-10-27") });
    expect(stageDateRange("T30", today)).toEqual({ from: d("2026-10-28"), to: d("2026-11-19") });
  });

  it("页面上的状态", () => {
    expect(entitlementStateLabel("VOIDED", 100)).toBe("已失效");
    expect(entitlementStateLabel("ACTIVE", -3)).toBe("已过期");
    expect(entitlementStateLabel("ACTIVE", 12)).toBe("即将到期");
    expect(entitlementStateLabel("ACTIVE", 200)).toBe("保障中");
    expect(entitlementStateLabel("ACTIVE", 600, 200)).toBe("未生效");
  });

  it("延保从保修到期次日起算，碎屏险从开单日起算（2026-10-20 坤总定）", () => {
    const ymd = (x: Date) => x.toISOString().slice(0, 10);
    const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
    const ext = entitlementPeriod("EXTENDED_WARRANTY", day("2026-01-15"), 12);
    expect([ymd(ext.startedOn), ymd(ext.expiresOn)]).toEqual(["2027-01-15", "2028-01-14"]);
    const screen = entitlementPeriod("SCREEN_INSURANCE", day("2026-01-15"), 12);
    expect([ymd(screen.startedOn), ymd(screen.expiresOn)]).toEqual(["2026-01-15", "2027-01-14"]);
    // 月底开单：保修到 2027-01-30，延保 2027-01-31 起
    const monthEnd = entitlementPeriod("EXTENDED_WARRANTY", day("2026-01-31"), 12);
    expect([ymd(monthEnd.startedOn), ymd(monthEnd.expiresOn)]).toEqual(["2027-01-31", "2028-01-30"]);
  });
});
