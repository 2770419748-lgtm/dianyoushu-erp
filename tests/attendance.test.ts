import { describe, expect, it } from "vitest";
import { bjDateKey, bjDateTime, bjMinuteOfDay, computeDay, dayLabel, isDateKey, leaveChain, leaveDays, leaveOn, monthDates, summarizeMonth, weekDates, weekStartOf } from "@/lib/attendance";

// 排班考勤怎么算（口径第 19 节）。纯函数，不连库。

const t = (date: string, hhmm: string, ss = 0) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return bjDateTime(date, h * 60 + m + ss / 60);
};
const NOW = t("2026-10-21", "23:00"); // 当天晚上 11 点看，当天的班都结束了

describe("日期都按北京时间", () => {
  it("UTC 16:00 已经是北京第二天 0 点", () => {
    expect(bjDateKey(new Date("2026-10-20T16:00:00Z"))).toBe("2026-10-21");
    expect(bjDateKey(new Date("2026-10-20T15:59:59Z"))).toBe("2026-10-20");
    expect(bjMinuteOfDay(new Date("2026-10-21T01:30:00Z"))).toBe(9 * 60 + 30);
    expect(bjDateTime("2026-10-21", 9 * 60).toISOString()).toBe("2026-10-21T01:00:00.000Z");
  });

  it("周一开头的一周、一个月的天数、请假天数含首尾、不存在的日期", () => {
    expect(weekStartOf("2026-10-21")).toBe("2026-10-19"); // 周三 → 周一
    expect(weekStartOf("2026-10-25")).toBe("2026-10-19"); // 周日算这一周
    expect(weekDates("2026-10-19").at(-1)).toBe("2026-10-25");
    expect(monthDates("2026-02")).toHaveLength(28);
    expect(monthDates("2028-02")).toHaveLength(29);
    expect(leaveDays("2026-10-30", "2026-11-01")).toBe(3);
    expect(isDateKey("2026-02-31")).toBe(false);
    expect(dayLabel("2026-10-21")).toBe("10-21 周三");
  });
});

describe("一天的考勤", () => {
  const day = "2026-10-21";
  it("早班 9:00～17:00：按整分钟算，9:05（含 9:05:59）不算迟到，9:06 算迟到 6 分钟；16:55 走不算早退，16:54:59 算早退 6 分钟", () => {
    expect(computeDay({ date: day, shift: "MORNING", punches: [{ kind: "IN", at: t(day, "09:05") }, { kind: "OUT", at: t(day, "16:55") }], leave: null, now: NOW })).toMatchObject({ lateMinutes: 0, earlyMinutes: 0, missing: false, absent: false, state: "WORK" });
    expect(computeDay({ date: day, shift: "MORNING", punches: [{ kind: "IN", at: t(day, "09:05", 59) }, { kind: "OUT", at: t(day, "17:10") }], leave: null, now: NOW }).lateMinutes).toBe(0);
    const late = computeDay({ date: day, shift: "MORNING", punches: [{ kind: "IN", at: t(day, "09:06", 1) }, { kind: "OUT", at: t(day, "16:54", 59) }], leave: null, now: NOW });
    expect(late).toMatchObject({ lateMinutes: 6, earlyMinutes: 6 });
    expect(late.label).toBe("早班 迟到 6 分钟，早退 6 分钟（上班 9:06，下班 16:54）"); // 分钟数和显示的时间对得上
    const early = computeDay({ date: day, shift: "MORNING", punches: [{ kind: "IN", at: t(day, "08:50") }, { kind: "OUT", at: t(day, "16:30") }], leave: null, now: NOW });
    expect(early).toMatchObject({ lateMinutes: 0, earlyMinutes: 30 });
    expect(early.label).toContain("早退 30 分钟");
  });

  it("早上误点了下班再点上班：那次下班不算（只认上班卡之后的下班卡），没再打下班就是缺卡", () => {
    const r = computeDay({ date: day, shift: "EVENING", punches: [{ kind: "OUT", at: t(day, "08:50") }, { kind: "IN", at: t(day, "12:55") }], leave: null, now: NOW });
    expect(r).toMatchObject({ earlyMinutes: 0, missing: true, lastOut: null });
    const fixed = computeDay({ date: day, shift: "EVENING", punches: [{ kind: "OUT", at: t(day, "08:50") }, { kind: "IN", at: t(day, "12:55") }, { kind: "OUT", at: t(day, "21:31") }], leave: null, now: NOW });
    expect(fixed).toMatchObject({ earlyMinutes: 0, missing: false, label: "晚班 正常（上班 12:55，下班 21:31）" });
  });

  it("上班卡取最早的、下班卡取最晚的（下班卡可以重复打）", () => {
    const r = computeDay({ date: day, shift: "EVENING", punches: [{ kind: "IN", at: t(day, "12:58") }, { kind: "OUT", at: t(day, "21:00") }, { kind: "OUT", at: t(day, "21:35") }], leave: null, now: NOW });
    expect(r).toMatchObject({ lateMinutes: 0, earlyMinutes: 0 });
    expect(r.lastOut?.toISOString()).toBe(t(day, "21:35").toISOString());
  });

  it("班结束了：一次都没打算缺勤，只打一次算缺卡；迟到同时缺卡两样都记", () => {
    expect(computeDay({ date: day, shift: "MIDDLE", punches: [], leave: null, now: NOW })).toMatchObject({ absent: true, missing: false, label: "中班 缺勤" });
    expect(computeDay({ date: day, shift: "MIDDLE", punches: [{ kind: "IN", at: t(day, "11:30") }], leave: null, now: NOW })).toMatchObject({ absent: false, missing: true, lateMinutes: 30 });
    expect(computeDay({ date: day, shift: "MIDDLE", punches: [{ kind: "OUT", at: t(day, "19:05") }], leave: null, now: NOW }).label).toContain("缺上班卡");
  });

  it("班还没结束只看迟到、不判缺卡缺勤；还没到的日子不算", () => {
    const noon = t(day, "12:00");
    expect(computeDay({ date: day, shift: "MORNING", punches: [{ kind: "IN", at: t(day, "08:55") }], leave: null, now: noon })).toMatchObject({ state: "IN_PROGRESS", missing: false, label: expect.stringContaining("上班中") });
    expect(computeDay({ date: day, shift: "EVENING", punches: [], leave: null, now: noon })).toMatchObject({ state: "IN_PROGRESS", absent: false });
    expect(computeDay({ date: "2026-10-22", shift: "MORNING", punches: [], leave: null, now: noon })).toMatchObject({ state: "UPCOMING", absent: false });
  });

  it("批了假算请假、不看打卡；休息日打卡算加班；没排班只列打卡", () => {
    expect(computeDay({ date: day, shift: "MORNING", punches: [], leave: "SICK", now: NOW })).toMatchObject({ state: "LEAVE", absent: false, label: "病假" });
    const ot = computeDay({ date: day, shift: "OFF", punches: [{ kind: "IN", at: t(day, "10:00") }, { kind: "OUT", at: t(day, "15:30") }], leave: null, now: NOW });
    expect(ot).toMatchObject({ state: "OVERTIME", overtimeMinutes: 330 });
    expect(computeDay({ date: day, shift: "OFF", punches: [], leave: null, now: NOW }).state).toBe("OFF");
    expect(computeDay({ date: day, shift: null, punches: [{ kind: "IN", at: t(day, "09:00") }], leave: null, now: NOW })).toMatchObject({ state: "UNSCHEDULED", absent: false, label: expect.stringContaining("没排班") });
  });
});

describe("月度统计和请假", () => {
  it("应出勤按排了上班的天数；请假、加班、迟到早退缺卡缺勤分别数", () => {
    const d = (date: string, extra: Parameters<typeof computeDay>[0]["punches"], shift: "MORNING" | "OFF" | null = "MORNING", leave: "PERSONAL" | null = null) => computeDay({ date, shift, punches: extra, leave, now: NOW });
    const days = [
      d("2026-10-01", [{ kind: "IN", at: t("2026-10-01", "08:55") }, { kind: "OUT", at: t("2026-10-01", "17:00") }]),
      d("2026-10-02", [{ kind: "IN", at: t("2026-10-02", "09:20") }, { kind: "OUT", at: t("2026-10-02", "16:00") }]),
      d("2026-10-03", [{ kind: "IN", at: t("2026-10-03", "09:00") }]),
      d("2026-10-04", []),
      d("2026-10-05", [], "MORNING", "PERSONAL"),
      d("2026-10-06", [{ kind: "IN", at: t("2026-10-06", "10:00") }, { kind: "OUT", at: t("2026-10-06", "14:00") }], "OFF"),
      d("2026-10-07", [], null),
    ];
    expect(summarizeMonth(days)).toEqual({ scheduled: 5, attended: 3, late: 1, early: 1, missing: 1, absent: 1, leaveDays: 1, overtimeDays: 1 });
    // 还没到的日子不算应出勤（本月看到一半时，应出勤和实际出勤能对着看）
    expect(summarizeMonth([...days, d("2026-10-25", [])]).scheduled).toBe(5);
  });

  it("请假要几级批：店员 1～2 天店长批，3 天及以上店长批完总部再批；店长、没门店的直接总部批", () => {
    expect(leaveChain("STAFF", true, 2)).toEqual(["STORE_MANAGER"]);
    expect(leaveChain("STAFF", true, 3)).toEqual(["STORE_MANAGER", "HQ"]);
    expect(leaveChain("STORE_MANAGER", true, 1)).toEqual(["HQ"]);
    expect(leaveChain("HQ", false, 5)).toEqual(["HQ"]);
    expect(leaveChain("REGIONAL_MANAGER", false, 1)).toEqual(["HQ"]);
  });

  it("某天被哪张假覆盖（含首尾）", () => {
    const leaves = [{ kind: "ANNUAL" as const, start: "2026-10-10", end: "2026-10-12" }];
    expect(leaveOn("2026-10-10", leaves)).toBe("ANNUAL");
    expect(leaveOn("2026-10-12", leaves)).toBe("ANNUAL");
    expect(leaveOn("2026-10-13", leaves)).toBeNull();
  });
});
