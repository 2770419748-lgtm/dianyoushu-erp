import { describe, expect, it } from "vitest";
import { addDays, daysBetween, GRACE_DAYS, isWritable, licenseNotice, licenseState, WARN_DAYS, type License } from "@/lib/license";

// 试用和到期（口径第 21 节）：到期日当天还能用；到期前 7 天提醒；到期后 15 天宽限照常用；再往后只读。

const trial: License = { plan: "TRIAL", startedOn: "2026-10-01", expiresOn: "2026-10-31", storeLimit: null };

describe("日期", () => {
  it("加天数、算差几天，跨月跨年都对", () => {
    expect(addDays("2026-10-01", 30)).toBe("2026-10-31");
    expect(addDays("2026-12-25", 10)).toBe("2027-01-04");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2026-10-23", "2026-10-31")).toBe(8);
    expect(daysBetween("2026-10-31", "2026-10-23")).toBe(-8);
  });
});

describe("开户状态", () => {
  it("演示模式不管到期；真用没开户信息算只读", () => {
    expect(licenseState(trial, "2030-01-01", true).kind).toBe("demo");
    expect(licenseState(null, "2026-10-23", false).kind).toBe("missing");
    expect(isWritable({ kind: "missing" })).toBe(false);
    expect(isWritable({ kind: "demo" })).toBe(true);
  });

  it("到期前 7 天以外正常，7 天内提醒，到期日当天还能用", () => {
    expect(licenseState(trial, addDays("2026-10-31", -(WARN_DAYS + 1)), false)).toMatchObject({ kind: "ok", daysLeft: WARN_DAYS + 1 });
    expect(licenseState(trial, addDays("2026-10-31", -WARN_DAYS), false)).toMatchObject({ kind: "expiring", daysLeft: WARN_DAYS });
    const lastDay = licenseState(trial, "2026-10-31", false);
    expect(lastDay).toMatchObject({ kind: "expiring", daysLeft: 0 });
    expect(isWritable(lastDay)).toBe(true);
    expect(licenseNotice(lastDay)?.text).toContain("今天到期");
  });

  it("到期后 15 天宽限照常用，第 16 天起只读", () => {
    const firstGrace = licenseState(trial, "2026-11-01", false);
    expect(firstGrace).toMatchObject({ kind: "grace", daysOver: 1, graceLeft: GRACE_DAYS - 1 });
    expect(isWritable(firstGrace)).toBe(true);
    const lastGrace = licenseState(trial, addDays("2026-10-31", GRACE_DAYS), false);
    expect(lastGrace).toMatchObject({ kind: "grace", graceLeft: 0 });
    expect(licenseNotice(lastGrace)?.text).toContain("明天起只能查看");
    const readonly = licenseState(trial, addDays("2026-10-31", GRACE_DAYS + 1), false);
    expect(readonly.kind).toBe("readonly");
    expect(isWritable(readonly)).toBe(false);
    expect(licenseNotice(readonly)?.level).toBe("error");
  });

  it("正常期不用提醒；续费（改到期日）后马上恢复", () => {
    expect(licenseNotice(licenseState(trial, "2026-10-01", false))).toBeNull();
    const renewed: License = { ...trial, plan: "PAID", expiresOn: "2027-10-31" };
    expect(isWritable(licenseState(renewed, "2026-12-31", false))).toBe(true);
  });
});
