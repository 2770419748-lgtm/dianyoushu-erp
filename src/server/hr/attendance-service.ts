import "server-only";
import { prisma } from "@/lib/prisma";
import {
  bjDateKey,
  bjDateTime,
  computeDay,
  dateFromKey,
  dateKeyOf,
  isDateKey,
  isMonthKey,
  leaveOn,
  minuteText,
  bjMinuteOfDay,
  monthDates,
  summarizeMonth,
  weekDates,
  weekStartOf,
  type DayResult,
  type PunchKindKey,
  type ShiftKindKey,
} from "@/lib/attendance";
import { canManageAttendance, canViewTeamAttendance } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { storeTableWhere } from "@/server/auth/scope";
import { writeAudit } from "@/server/audit";
import { type Db, withTx } from "@/server/db-tx";
import { employeeScopeWhere } from "./employee-service";
import { approvedLeaves, editableRange } from "./schedule-service";

// 考勤（口径第 19 节）：员工在 ERP 上打上班卡、下班卡（不做定位、人脸）；漏打的由店长补录（写原因、记日志）；
// 按当天的班算迟到、早退、缺卡、缺勤，批了的请假不算缺勤，休息日打卡算加班（只记录）；月度统计给店长、区域经理、总部看。

export class AttendanceError extends Error {}

const PUNCH_LOCK_NS = -77; // 咨询锁命名空间：-73 维修串号、-74 国补客户、-75 运营商结算、-76 发票号码、-77 打卡、-78 请假
const PUNCH_KINDS: PunchKindKey[] = ["IN", "OUT"];

/** 某人某天的班 */
async function shiftOn(db: Db, userId: number, date: string): Promise<ShiftKindKey | null> {
  const s = await db.shiftSchedule.findUnique({ where: { userId_date: { userId, date: dateFromKey(date) } }, select: { shift: true } });
  return s?.shift ?? null;
}

/** 员工自己打卡：上班卡一天一次（要改找店长补录），下班卡可以重复打、以最后一次为准（一分钟内不能连打） */
export async function punch(user: CurrentUser, kind: unknown, opts: { db?: Db; now?: Date } = {}) {
  if (!PUNCH_KINDS.includes(kind as PunchKindKey)) throw new AttendanceError("打卡类型不对");
  const k = kind as PunchKindKey;
  const now = opts.now ?? new Date();
  const date = bjDateKey(now);
  return withTx(opts.db ?? prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUNCH_LOCK_NS}::int, ${user.id}::int)`; // 同一个人连点两下只记一次
    const today = await tx.attendancePunch.findMany({ where: { userId: user.id, date: dateFromKey(date) }, orderBy: { at: "asc" } });
    if (k === "IN") {
      const first = today.find((p) => p.kind === "IN");
      if (first) throw new AttendanceError(`今天 ${minuteText(bjMinuteOfDay(first.at))} 已经打过上班卡了；打错了找店长补录`);
    } else {
      const last = today.filter((p) => p.kind === "OUT").at(-1);
      if (last && now.getTime() - last.at.getTime() < 60 * 1000) throw new AttendanceError("刚打过下班卡了");
    }
    await tx.attendancePunch.create({ data: { userId: user.id, storeId: user.storeId, date: dateFromKey(date), kind: k, at: now, createdById: user.id } });
    const shift = await shiftOn(tx, user.id, date);
    const day = computeDay({ date, shift, punches: [...today, { kind: k, at: now }], leave: null, now });
    return { at: now, kind: k, label: day.label };
  });
}

/** 店长（本店员工）、总部给别人补卡：要写原因，记日志；不能给自己补，不能补还没到的时间 */
export async function addManualPunch(user: CurrentUser, input: { userId: unknown; date: unknown; kind: unknown; time: unknown; note: unknown }, opts: { db?: Db; now?: Date } = {}) {
  if (!canManageAttendance(user.role)) throw new AttendanceError("补卡只有店长和总部能做");
  const now = opts.now ?? new Date();
  const userId = Number(input.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new AttendanceError("员工不对");
  if (userId === user.id) throw new AttendanceError("不能给自己补卡，找总部补");
  if (!PUNCH_KINDS.includes(input.kind as PunchKindKey)) throw new AttendanceError("打卡类型不对");
  if (!isDateKey(input.date)) throw new AttendanceError("日期不对");
  const time = typeof input.time === "string" ? input.time.trim() : "";
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new AttendanceError("时间填 09:00 这样的");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 100) : "";
  if (!note) throw new AttendanceError("写一下补卡原因");
  const range = editableRange(bjDateKey(now));
  if (input.date < range.from) throw new AttendanceError(`只能补 ${range.from} 以后的卡`);
  const at = bjDateTime(input.date, Number(m[1]) * 60 + Number(m[2]));
  if (at.getTime() > now.getTime()) throw new AttendanceError("不能补还没到的时间");
  const date = input.date;
  return withTx(opts.db ?? prisma, async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true, storeId: true, isActive: true } });
    if (!target || !target.isActive) throw new AttendanceError("员工不存在或已经停用");
    if (user.role !== "HQ" && (!user.storeId || target.storeId !== user.storeId)) throw new AttendanceError("店长只能给本店员工补卡");
    const created = await tx.attendancePunch.create({ data: { userId, storeId: target.storeId, date: dateFromKey(date), kind: input.kind as PunchKindKey, at, manual: true, note, createdById: user.id } });
    await writeAudit({ userId: user.id, action: "attendance.manual", entity: "user", entityId: userId, detail: { date, kind: input.kind as PunchKindKey, time, note } }, tx);
    return { id: created.id, name: target.name };
  });
}

/** 今天的打卡页：今天的班、打了哪几次、算出来怎样，本周的班 */
export async function getMyToday(user: CurrentUser, now = new Date()) {
  const date = bjDateKey(now);
  const week = weekDates(weekStartOf(date));
  const [punches, shifts, leaves] = await Promise.all([
    prisma.attendancePunch.findMany({ where: { userId: user.id, date: dateFromKey(date) }, orderBy: { at: "asc" }, select: { kind: true, at: true, manual: true } }),
    prisma.shiftSchedule.findMany({ where: { userId: user.id, date: { gte: dateFromKey(week[0]!), lte: dateFromKey(week[6]!) } }, select: { date: true, shift: true } }),
    approvedLeaves(prisma, [user.id], week[0]!, week[6]!),
  ]);
  const myLeaves = leaves.get(user.id) ?? [];
  const shiftOf = (d: string) => shifts.find((s) => dateKeyOf(s.date) === d)?.shift ?? null;
  const day = computeDay({ date, shift: shiftOf(date), punches, leave: leaveOn(date, myLeaves), now });
  return {
    date,
    day,
    punches,
    hasIn: punches.some((p) => p.kind === "IN"),
    week: week.map((d) => ({ date: d, shift: shiftOf(d), leave: leaveOn(d, myLeaves), isToday: d === date })),
  };
}

function currentMonth(now: Date): string {
  return bjDateKey(now).slice(0, 7);
}

/** 一批人一个月的每日考勤（按人） */
async function monthDays(db: Db, userIds: number[], month: string, now: Date): Promise<Map<number, DayResult[]>> {
  const dates = monthDates(month);
  const from = dates[0]!;
  const to = dates.at(-1)!;
  const [shifts, punches, leaves] = await Promise.all([
    db.shiftSchedule.findMany({ where: { userId: { in: userIds }, date: { gte: dateFromKey(from), lte: dateFromKey(to) } }, select: { userId: true, date: true, shift: true } }),
    db.attendancePunch.findMany({ where: { userId: { in: userIds }, date: { gte: dateFromKey(from), lte: dateFromKey(to) } }, select: { userId: true, date: true, kind: true, at: true } }),
    approvedLeaves(db, userIds, from, to),
  ]);
  const shiftMap = new Map(shifts.map((s) => [`${s.userId}|${dateKeyOf(s.date)}`, s.shift]));
  const punchMap = new Map<string, { kind: PunchKindKey; at: Date }[]>();
  for (const p of punches) {
    const key = `${p.userId}|${dateKeyOf(p.date)}`;
    const list = punchMap.get(key) ?? [];
    list.push({ kind: p.kind, at: p.at });
    punchMap.set(key, list);
  }
  const result = new Map<number, DayResult[]>();
  for (const id of userIds) {
    const myLeaves = leaves.get(id) ?? [];
    result.set(
      id,
      dates.map((d) => computeDay({ date: d, shift: shiftMap.get(`${id}|${d}`) ?? null, punches: punchMap.get(`${id}|${d}`) ?? [], leave: leaveOn(d, myLeaves), now })),
    );
  }
  return result;
}

/** 一个人一个月的考勤汇总（工资条算缺勤扣款也用它） */
export async function userMonthSummary(db: Db, userId: number, month: string, now = new Date()) {
  const days = (await monthDays(db, [userId], month, now)).get(userId) ?? [];
  return summarizeMonth(days);
}

/** 月度统计：店员只有自己；店长本店；区域经理辖区；总部全部（可按门店筛） */
export async function monthStats(user: CurrentUser, query: { month?: string; storeId?: number }, now = new Date()) {
  const month = isMonthKey(query.month) ? query.month : currentMonth(now);
  const team = canViewTeamAttendance(user.role);
  const stores = team ? await prisma.store.findMany({ where: storeTableWhere(user), orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }) : [];
  const storeId = query.storeId && stores.some((s) => s.id === query.storeId) ? query.storeId : undefined;
  const people = team
    ? await prisma.user.findMany({
        where: { AND: [employeeScopeWhere(user), { isActive: true, storeId: storeId ?? { not: null }, role: { in: ["STAFF", "STORE_MANAGER"] } }] },
        orderBy: [{ storeId: "asc" }, { role: "desc" }, { id: "asc" }],
        take: 500,
        select: { id: true, name: true, role: true, store: { select: { code: true, name: true } } },
      })
    : [{ id: user.id, name: user.name, role: user.role, store: user.store ? { code: "", name: user.store.name } : null }];
  const days = await monthDays(prisma, people.map((p) => p.id), month, now);
  return {
    month,
    stores,
    storeId: storeId ?? null,
    team,
    canManage: canManageAttendance(user.role),
    rows: people.map((p) => ({ userId: p.id, name: p.name, role: p.role, store: p.store ? `${p.store.code} ${p.store.name}`.trim() : "—", summary: summarizeMonth(days.get(p.id) ?? []) })),
  };
}

export type MonthStats = Awaited<ReturnType<typeof monthStats>>;

/** 一个人一个月每天的考勤明细：本人，或者在自己范围内的员工 */
export async function userMonthDetail(user: CurrentUser, userId: number, month: string, now = new Date()) {
  if (!isMonthKey(month)) throw new AttendanceError("月份不对");
  if (userId !== user.id) {
    if (!canViewTeamAttendance(user.role)) throw new AttendanceError("只能看自己的考勤");
    const ok = await prisma.user.count({ where: { AND: [employeeScopeWhere(user), { id: userId }] } });
    if (!ok) throw new AttendanceError("这个员工不在你的范围内");
  }
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const days = (await monthDays(prisma, [userId], month, now)).get(userId) ?? [];
  const manual = await prisma.attendancePunch.findMany({
    where: { userId, manual: true, date: { gte: dateFromKey(`${month}-01`), lte: dateFromKey(monthDates(month).at(-1)!) } },
    orderBy: { at: "asc" },
    select: { date: true, kind: true, at: true, note: true, createdBy: { select: { name: true } } },
  });
  return {
    name: target?.name ?? "",
    days: days.map((d) => ({ date: d.date, shift: d.shift, state: d.state, label: d.label, late: d.lateMinutes > 0, early: d.earlyMinutes > 0, missing: d.missing, absent: d.absent })),
    manual: manual.map((p) => ({ date: dateKeyOf(p.date), kind: p.kind, time: minuteText(bjMinuteOfDay(p.at)), note: p.note, by: p.createdBy.name })),
    summary: summarizeMonth(days),
  };
}

export type UserMonthDetail = Awaited<ReturnType<typeof userMonthDetail>>;

/** 补卡弹窗里能选的人：店长本店在职员工（不含自己），总部全部门店员工 */
export async function manualPunchTargets(user: CurrentUser) {
  if (!canManageAttendance(user.role)) return [];
  return prisma.user.findMany({
    where: { isActive: true, id: { not: user.id }, role: { in: ["STAFF", "STORE_MANAGER"] }, ...(user.role === "HQ" ? { storeId: { not: null } } : { storeId: user.storeId ?? -1 }) },
    orderBy: [{ storeId: "asc" }, { id: "asc" }],
    take: 500,
    select: { id: true, name: true, store: { select: { code: true, name: true } } },
  });
}
