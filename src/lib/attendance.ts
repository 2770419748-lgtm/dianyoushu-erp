// 排班、考勤、请假（口径第 19 节）：班次时间、迟到早退缺卡缺勤怎么算、月度统计、请假要几级批。
// 纯函数，服务层、页面、演示数据生成、单元测试共用（tests/attendance.test.ts）。

export type ShiftKindKey = "MORNING" | "MIDDLE" | "EVENING" | "OFF";
export type WorkShiftKey = Exclude<ShiftKindKey, "OFF">;
export type PunchKindKey = "IN" | "OUT";
export type LeaveKindKey = "PERSONAL" | "SICK" | "ANNUAL" | "COMPENSATORY";
export type OaStatusKey = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
type RoleKey = "STAFF" | "STORE_MANAGER" | "REGIONAL_MANAGER" | "HQ";

export const SHIFT_KINDS: ShiftKindKey[] = ["MORNING", "MIDDLE", "EVENING", "OFF"];
export const SHIFT_LABELS: Record<ShiftKindKey, string> = { MORNING: "早班", MIDDLE: "中班", EVENING: "晚班", OFF: "休息" };
export const SHIFT_COLORS: Record<ShiftKindKey, string> = { MORNING: "blue", MIDDLE: "cyan", EVENING: "purple", OFF: "default" };

/** 班次的上下班时间：北京时间从 0 点起的分钟数（早 9:00～17:00、中 11:00～19:00、晚 13:00～21:30） */
export const SHIFT_TIMES: Record<WorkShiftKey, { start: number; end: number }> = {
  MORNING: { start: 9 * 60, end: 17 * 60 },
  MIDDLE: { start: 11 * 60, end: 19 * 60 },
  EVENING: { start: 13 * 60, end: 21 * 60 + 30 },
};

/** 宽限：上班晚 5 分钟以内、下班早 5 分钟以内都不算。打卡时间按整分钟算（秒舍掉）：9:05:59 是 9:05，不算迟到；9:06 算迟到 6 分钟 */
export const GRACE_MINUTES = 5;

export const PUNCH_LABELS: Record<PunchKindKey, string> = { IN: "上班", OUT: "下班" };
export const LEAVE_KINDS: LeaveKindKey[] = ["PERSONAL", "SICK", "ANNUAL", "COMPENSATORY"];
export const LEAVE_KIND_LABELS: Record<LeaveKindKey, string> = { PERSONAL: "事假", SICK: "病假", ANNUAL: "年假", COMPENSATORY: "调休" };
export const OA_STATUS_LABELS: Record<OaStatusKey, string> = { PENDING: "审批中", APPROVED: "已批", REJECTED: "驳回", CANCELLED: "撤回" };
export const OA_STATUS_COLORS: Record<OaStatusKey, string> = { PENDING: "blue", APPROVED: "green", REJECTED: "red", CANCELLED: "default" };

/** 请假几天（含）以上要总部再批 */
export const LEAVE_HQ_DAYS = 3;
/** 一张请假单最多请几天 */
export const LEAVE_MAX_DAYS = 30;
/** 最早能补请多少天以前的假（病假常常是事后补） */
export const LEAVE_BACKDATE_DAYS = 31;

const BJ_OFFSET_MS = 8 * 3600 * 1000; // 北京时间没有夏令时，固定比 UTC 早 8 小时
const DAY_MS = 24 * 3600 * 1000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 分钟数 → “9:00”“21:30” */
export function minuteText(minute: number): string {
  const m = Math.floor(minute);
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

export function shiftTimeText(shift: ShiftKindKey): string {
  if (shift === "OFF") return "休息";
  const t = SHIFT_TIMES[shift];
  return `${minuteText(t.start)}～${minuteText(t.end)}`;
}

// ---------- 日期（都用 "2026-10-21" 这种北京日期的文字；存库的 @db.Date 是 UTC 零点） ----------

/** 一个时刻在北京时间是哪天 */
export function bjDateKey(at: Date): string {
  return new Date(at.getTime() + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 一个时刻在北京时间是当天的第几分钟（带小数，精确到秒） */
export function bjMinuteOfDay(at: Date): number {
  const ms = (((at.getTime() + BJ_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  return ms / 60000;
}

/** 某天北京时间第几分钟是哪个时刻 */
export function bjDateTime(dateKey: string, minute: number): Date {
  return new Date(Date.parse(`${dateKey}T00:00:00.000Z`) - BJ_OFFSET_MS + Math.round(minute * 60000));
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value; // 2026-02-31 这种转回去对不上
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** 存库用的日期（UTC 零点） */
export function dateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** 库里的 @db.Date → "2026-10-21" */
export function dateKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(key: string, n: number): string {
  return dateKeyOf(new Date(Date.parse(`${key}T00:00:00.000Z`) + n * DAY_MS));
}

/** 两个日期差几天（后减前） */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

/** 请假天数：含首尾，按自然日 */
export function leaveDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}

/** 这一周的周一（排班一周一屏，周一开头） */
export function weekStartOf(key: string): string {
  const dow = (new Date(`${key}T00:00:00.000Z`).getUTCDay() + 6) % 7; // 周一 0 … 周日 6
  return addDays(key, -dow);
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
/** “10-21 周二” */
export function dayLabel(key: string): string {
  return `${key.slice(5)} 周${WEEKDAY[new Date(`${key}T00:00:00.000Z`).getUTCDay()]}`;
}

/** 一个月的每一天 */
export function monthDates(month: string): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${pad(i + 1)}`);
}

// ---------- 请假 ----------

/**
 * 请假要几级批：门店店员请 1～2 天店长批，3 天及以上店长批完总部再批；
 * 店长、区域经理、总部的人（本来就是店长，或者没有门店）直接总部批。
 */
export function leaveChain(role: RoleKey, hasStore: boolean, days: number): ("STORE_MANAGER" | "HQ")[] {
  if (role === "STAFF" && hasStore) return days >= LEAVE_HQ_DAYS ? ["STORE_MANAGER", "HQ"] : ["STORE_MANAGER"];
  return ["HQ"];
}

// ---------- 考勤 ----------

export interface PunchFact {
  kind: PunchKindKey;
  at: Date;
}

export type DayStateKey = "WORK" | "IN_PROGRESS" | "UPCOMING" | "LEAVE" | "OFF" | "OVERTIME" | "UNSCHEDULED";

export interface DayResult {
  date: string;
  shift: ShiftKindKey | null;
  state: DayStateKey;
  firstIn: Date | null; // 当天最早的上班卡
  lastOut: Date | null; // 当天最晚的下班卡
  lateMinutes: number; // 迟到几分钟（没迟到 0）
  earlyMinutes: number; // 早退几分钟
  missing: boolean; // 缺卡：只打了一次
  absent: boolean; // 缺勤：排了班一次都没打
  leave: LeaveKindKey | null;
  overtimeMinutes: number; // 休息日打了上下班卡，记下多少分钟（只记录不算钱）
  label: string; // 给人看的一句话
  future: boolean; // 还没到的日子（北京时间今天以后）
}

/**
 * 按当天的班算一天的考勤（口径第 19 节）：
 * - 请了假（批了的）：算请假，不看打卡；
 * - 没排班：只列出打卡，不判断；休息日打了卡算加班（只记录）；
 * - 排了班：上班卡晚于上班时间 5 分钟以上算迟到，下班卡早于下班时间 5 分钟以上算早退；
 *   这天的班结束了还一次都没打算缺勤，只打了一次算缺卡；班还没结束只看迟到，不判缺卡缺勤。
 */
export function computeDay(input: { date: string; shift: ShiftKindKey | null; punches: PunchFact[]; leave: LeaveKindKey | null; now: Date }): DayResult {
  const { date, shift, punches, leave, now } = input;
  const ins = punches.filter((p) => p.kind === "IN").map((p) => p.at.getTime());
  const firstIn = ins.length ? new Date(Math.min(...ins)) : null;
  // 下班卡只认上班卡之后的（早上误点了下班再点上班，那次下班不算，不然会算成一大段早退）
  const outs = punches.filter((p) => p.kind === "OUT" && (!firstIn || p.at.getTime() > firstIn.getTime())).map((p) => p.at.getTime());
  const lastOut = outs.length ? new Date(Math.max(...outs)) : null;
  const today = bjDateKey(now);
  const base: DayResult = { date, shift, state: "UNSCHEDULED", firstIn, lastOut, lateMinutes: 0, earlyMinutes: 0, missing: false, absent: false, leave: null, overtimeMinutes: 0, label: "", future: date > today };
  const punchText = [firstIn ? `上班 ${minuteText(bjMinuteOfDay(firstIn))}` : null, lastOut ? `下班 ${minuteText(bjMinuteOfDay(lastOut))}` : null].filter(Boolean).join("，");

  if (leave) return { ...base, state: "LEAVE", leave, label: LEAVE_KIND_LABELS[leave] };
  if (shift === null) return { ...base, label: punchText ? `没排班（${punchText}）` : "没排班" };
  if (shift === "OFF") {
    if (!firstIn && !lastOut) return { ...base, state: "OFF", label: "休息" };
    const minutes = firstIn && lastOut && lastOut > firstIn ? Math.floor((lastOut.getTime() - firstIn.getTime()) / 60000) : 0;
    return { ...base, state: "OVERTIME", overtimeMinutes: minutes, label: `休息日加班${minutes ? ` ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : ""}（${punchText}）` };
  }

  if (base.future) return { ...base, state: "UPCOMING", label: `${SHIFT_LABELS[shift]}（还没到）` };
  const t = SHIFT_TIMES[shift];
  const finished = date < today || bjMinuteOfDay(now) >= t.end;
  // 按整分钟算，和显示的“上班 9:05”对得上
  const inMin = firstIn ? Math.floor(bjMinuteOfDay(firstIn)) : null;
  const outMin = lastOut ? Math.floor(bjMinuteOfDay(lastOut)) : null;
  const lateMinutes = inMin !== null && inMin - t.start > GRACE_MINUTES ? inMin - t.start : 0;
  const earlyMinutes = outMin !== null && t.end - outMin > GRACE_MINUTES ? t.end - outMin : 0;
  const absent = finished && !firstIn && !lastOut;
  const missing = finished && !absent && (!firstIn || !lastOut);
  const parts = [
    lateMinutes ? `迟到 ${lateMinutes} 分钟` : null,
    earlyMinutes ? `早退 ${earlyMinutes} 分钟` : null,
    missing ? (firstIn ? "缺下班卡" : "缺上班卡") : null,
    absent ? "缺勤" : null,
  ].filter(Boolean);
  const state: DayStateKey = finished ? "WORK" : "IN_PROGRESS";
  const label = parts.length ? parts.join("，") : finished ? "正常" : firstIn ? "上班中" : "还没打上班卡";
  return { ...base, state, lateMinutes, earlyMinutes, missing, absent, label: `${SHIFT_LABELS[shift]} ${label}${punchText && !absent ? `（${punchText}）` : ""}` };
}

export interface MonthSummary {
  scheduled: number; // 应出勤：排了上班的天数（到今天为止；过完的月份就是整月）
  attended: number; // 实际出勤：排了班、没请假、打过卡的天数
  late: number;
  early: number;
  missing: number;
  absent: number;
  leaveDays: number; // 批了的请假覆盖到这个月的天数（自然日）
  overtimeDays: number;
}

export function summarizeMonth(days: DayResult[]): MonthSummary {
  const s: MonthSummary = { scheduled: 0, attended: 0, late: 0, early: 0, missing: 0, absent: 0, leaveDays: 0, overtimeDays: 0 };
  for (const d of days) {
    if (d.shift && d.shift !== "OFF" && !d.future) s.scheduled++;
    if (d.state === "LEAVE") {
      s.leaveDays++;
      continue;
    }
    if (d.state === "OVERTIME") s.overtimeDays++;
    if ((d.state === "WORK" || d.state === "IN_PROGRESS") && (d.firstIn || d.lastOut)) s.attended++;
    if (d.lateMinutes) s.late++;
    if (d.earlyMinutes) s.early++;
    if (d.missing) s.missing++;
    if (d.absent) s.absent++;
  }
  return s;
}

/** 某天被哪张批了的假覆盖（假期按日期含首尾） */
export function leaveOn(date: string, leaves: { kind: LeaveKindKey; start: string; end: string }[]): LeaveKindKey | null {
  return leaves.find((l) => l.start <= date && date <= l.end)?.kind ?? null;
}
