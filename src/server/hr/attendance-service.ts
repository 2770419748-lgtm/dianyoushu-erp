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
// 按“那天在哪家店”算（2026-10-21 复查后定）：一天算哪家店看那天的排班门店（没排班看打卡记的门店）。调了店的人，
// 老店的统计里还有他调走前那几天，新店只算调来以后的；补卡记那天的门店，只有那家店的店长能补；停用的人在他上过班的月份照样列出来。

export class AttendanceError extends Error {}

const PUNCH_LOCK_NS = -77; // 咨询锁命名空间：-73 维修串号、-74 国补客户、-75 运营商结算、-76 发票号码、-77 打卡、-78 请假、-79 智能提醒、-80 工资、-81 门店数上限
const PUNCH_KINDS: PunchKindKey[] = ["IN", "OUT"];

/** 某人某天的班 */
async function shiftOn(db: Db, userId: number, date: string): Promise<{ shift: ShiftKindKey; storeId: number } | null> {
  return db.shiftSchedule.findUnique({ where: { userId_date: { userId, date: dateFromKey(date) } }, select: { shift: true, storeId: true } });
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
    const shift = await shiftOn(tx, user.id, date);
    await tx.attendancePunch.create({ data: { userId: user.id, storeId: shift?.storeId ?? user.storeId, date: dateFromKey(date), kind: k, at: now, createdById: user.id } }); // 记那天排班的门店
    const day = computeDay({ date, shift: shift?.shift ?? null, punches: [...today, { kind: k, at: now }], leave: null, now });
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
    // 补卡记那天的门店：那天排了班就是排班的门店，没排班算他现在的门店；店长只能补那天在本店的
    const dayStore = (await shiftOn(tx, userId, date))?.storeId ?? target.storeId;
    if (user.role !== "HQ" && (!user.storeId || dayStore !== user.storeId)) throw new AttendanceError("店长只能给那天在本店上班的员工补卡");
    const created = await tx.attendancePunch.create({ data: { userId, storeId: dayStore, date: dateFromKey(date), kind: input.kind as PunchKindKey, at, manual: true, note, createdById: user.id } });
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

/** 一天的考勤，带上那天算哪家店（那天的排班门店；没排班看打卡记的门店；都没有是 null） */
export type DayWithStore = DayResult & { storeId: number | null };

function monthRangeOf(month: string) {
  return { gte: dateFromKey(`${month}-01`), lte: dateFromKey(monthDates(month).at(-1)!) };
}

/** 一批人一个月的每日考勤（按人） */
async function monthDays(db: Db, userIds: number[], month: string, now: Date): Promise<Map<number, DayWithStore[]>> {
  const dates = monthDates(month);
  const range = monthRangeOf(month);
  const [shifts, punches, leaves] = await Promise.all([
    db.shiftSchedule.findMany({ where: { userId: { in: userIds }, date: range }, select: { userId: true, date: true, shift: true, storeId: true } }),
    db.attendancePunch.findMany({ where: { userId: { in: userIds }, date: range }, select: { userId: true, date: true, kind: true, at: true, storeId: true } }),
    approvedLeaves(db, userIds, dates[0]!, dates.at(-1)!),
  ]);
  const shiftMap = new Map(shifts.map((s) => [`${s.userId}|${dateKeyOf(s.date)}`, s]));
  const punchMap = new Map<string, { kind: PunchKindKey; at: Date }[]>();
  const punchStore = new Map<string, number>();
  for (const p of punches) {
    const key = `${p.userId}|${dateKeyOf(p.date)}`;
    const list = punchMap.get(key) ?? [];
    list.push({ kind: p.kind, at: p.at });
    punchMap.set(key, list);
    if (p.storeId !== null && !punchStore.has(key)) punchStore.set(key, p.storeId);
  }
  const result = new Map<number, DayWithStore[]>();
  for (const id of userIds) {
    const myLeaves = leaves.get(id) ?? [];
    result.set(
      id,
      dates.map((d) => {
        const key = `${id}|${d}`;
        const shift = shiftMap.get(key);
        return { ...computeDay({ date: d, shift: shift?.shift ?? null, punches: punchMap.get(key) ?? [], leave: leaveOn(d, myLeaves), now }), storeId: shift?.storeId ?? punchStore.get(key) ?? null };
      }),
    );
  }
  return result;
}

/** 这一天算不算在这几家店：那天的门店，没有就按他现在的门店；allowed 为 null 是不限门店 */
function inStores(day: DayWithStore, currentStoreId: number | null, allowed: Set<number> | null): boolean {
  if (!allowed) return true;
  const store = day.storeId ?? currentStoreId;
  return store !== null && allowed.has(store);
}

/** 一个人一个月的考勤汇总（工资条算缺勤扣款也用它） */
export async function userMonthSummary(db: Db, userId: number, month: string, now = new Date()) {
  const days = (await monthDays(db, [userId], month, now)).get(userId) ?? [];
  return summarizeMonth(days);
}

/** 一个人一个月每家店上了几天班（工资分摊到门店用：按那天在哪家店） */
export async function userMonthStoreDays(db: Db, userId: number, month: string, now = new Date()): Promise<Map<number, number>> {
  return (await monthSummaries(db, [userId], month, now)).get(userId)?.storeDays ?? new Map();
}

/**
 * 一批人一个月的考勤汇总（按人整月）和每家店上了几天班（排了上班的日子按那天的排班门店数），生成工资条一次查完。
 * windows 给了就只算在职那几天（入职日到离职日，含当天）：离职以后、入职以前排着的班不算缺勤、不算上班天数（底薪已经按在职天数折算过了）
 */
export async function monthSummaries(db: Db, userIds: number[], month: string, now = new Date(), windows?: Map<number, { from: string; to: string }>) {
  const all = await monthDays(db, userIds, month, now);
  const out = new Map<number, { summary: ReturnType<typeof summarizeMonth>; storeDays: Map<number, number> }>();
  for (const id of userIds) {
    const w = windows?.get(id);
    const days = (all.get(id) ?? []).filter((d) => !w || (d.date >= w.from && d.date <= w.to));
    const storeDays = new Map<number, number>();
    for (const d of days) if (d.storeId !== null && d.shift && d.shift !== "OFF") storeDays.set(d.storeId, (storeDays.get(d.storeId) ?? 0) + 1);
    out.set(id, { summary: summarizeMonth(days), storeDays });
  }
  return out;
}

/** 月度统计：店员只有自己；店长本店；区域经理辖区；总部全部（可按门店筛） */
export async function monthStats(user: CurrentUser, query: { month?: string; storeId?: number }, now = new Date(), db: Db = prisma) {
  const month = isMonthKey(query.month) ? query.month : currentMonth(now);
  const team = canViewTeamAttendance(user.role);
  const stores = team ? await db.store.findMany({ where: storeTableWhere(user), orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }) : [];
  const storeId = query.storeId && stores.some((s) => s.id === query.storeId) ? query.storeId : undefined;
  // 只算这几家店的日子：选了门店就是那家；店长、区域经理是自己范围里的店；总部不限
  const allowed: Set<number> | null = !team ? null : storeId ? new Set([storeId]) : user.role === "HQ" ? null : new Set(stores.map((s) => s.id));
  type Person = { id: number; name: string; role: string; isActive: boolean; storeId: number | null; store: { code: string; name: string } | null };
  let people: Person[];
  if (team) {
    const range = monthRangeOf(month);
    const inAllowed = allowed ? { storeId: { in: [...allowed] } } : {};
    const [current, shifted, punched] = await Promise.all([
      db.user.findMany({ where: { AND: [employeeScopeWhere(user), { isActive: true, storeId: storeId ?? { not: null }, role: { in: ["STAFF", "STORE_MANAGER"] } }] }, select: { id: true } }),
      // 这个月在这些店排过班、打过卡的人（调走的、停用的也算）
      db.shiftSchedule.findMany({ where: { date: range, ...inAllowed }, distinct: ["userId"], select: { userId: true } }),
      db.attendancePunch.findMany({ where: { date: range, ...(allowed ? inAllowed : { storeId: { not: null } }) }, distinct: ["userId"], select: { userId: true } }),
    ]);
    const ids = [...new Set([...current.map((u) => u.id), ...shifted.map((r) => r.userId), ...punched.map((r) => r.userId)])];
    people = await db.user.findMany({
      where: { id: { in: ids }, role: { in: ["STAFF", "STORE_MANAGER"] } },
      orderBy: [{ storeId: "asc" }, { role: "desc" }, { id: "asc" }],
      take: 500,
      select: { id: true, name: true, role: true, isActive: true, storeId: true, store: { select: { code: true, name: true } } },
    });
  } else {
    people = [{ id: user.id, name: user.name, role: user.role, isActive: true, storeId: user.storeId, store: user.store ? { code: "", name: user.store.name } : null }];
  }
  const days = await monthDays(db, people.map((p) => p.id), month, now);
  return {
    month,
    stores,
    storeId: storeId ?? null,
    team,
    canManage: canManageAttendance(user.role),
    rows: people.map((p) => ({
      userId: p.id,
      name: p.name,
      role: p.role,
      store: p.store ? `${p.store.code} ${p.store.name}`.trim() : "—",
      note: !p.isActive ? "已停用" : allowed && p.storeId !== null && !allowed.has(p.storeId) ? "已调走" : null,
      summary: summarizeMonth((days.get(p.id) ?? []).filter((d) => inStores(d, p.storeId, allowed))),
    })),
  };
}

export type MonthStats = Awaited<ReturnType<typeof monthStats>>;

/** 一个人一个月每天的考勤明细：本人，或者在自己范围内的员工 */
export async function userMonthDetail(user: CurrentUser, userId: number, month: string, now = new Date(), db: Db = prisma) {
  if (!isMonthKey(month)) throw new AttendanceError("月份不对");
  let allowed: Set<number> | null = null; // 店长、区域经理只看那天在自己范围里的店的日子
  if (userId !== user.id) {
    if (!canViewTeamAttendance(user.role)) throw new AttendanceError("只能看自己的考勤");
    if (user.role !== "HQ") {
      allowed = new Set((await db.store.findMany({ where: storeTableWhere(user), select: { id: true } })).map((s) => s.id));
      const range = monthRangeOf(month);
      const inScope = await db.user.count({ where: { AND: [employeeScopeWhere(user), { id: userId }] } });
      const worked = inScope ? 1 : (await db.shiftSchedule.count({ where: { userId, date: range, storeId: { in: [...allowed] } } })) + (await db.attendancePunch.count({ where: { userId, date: range, storeId: { in: [...allowed] } } }));
      if (!worked) throw new AttendanceError("这个员工不在你的范围内");
    }
  }
  const target = await db.user.findUnique({ where: { id: userId }, select: { name: true, storeId: true } });
  const days = (await monthDays(db, [userId], month, now)).get(userId) ?? [];
  const visible = (d: DayWithStore) => inStores(d, target?.storeId ?? null, allowed);
  const manual = await db.attendancePunch.findMany({
    where: { userId, manual: true, date: monthRangeOf(month), ...(allowed ? { storeId: { in: [...allowed] } } : {}) },
    orderBy: { at: "asc" },
    select: { date: true, kind: true, at: true, note: true, createdBy: { select: { name: true } } },
  });
  return {
    name: target?.name ?? "",
    days: days.map((d) =>
      visible(d)
        ? { date: d.date, shift: d.shift, state: d.state, label: d.label, late: d.lateMinutes > 0, early: d.earlyMinutes > 0, missing: d.missing, absent: d.absent }
        : { date: d.date, shift: null, state: "UNSCHEDULED" as const, label: "在别的店", late: false, early: false, missing: false, absent: false },
    ),
    manual: manual.map((p) => ({ date: dateKeyOf(p.date), kind: p.kind, time: minuteText(bjMinuteOfDay(p.at)), note: p.note, by: p.createdBy.name })),
    summary: summarizeMonth(days.filter(visible)),
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
