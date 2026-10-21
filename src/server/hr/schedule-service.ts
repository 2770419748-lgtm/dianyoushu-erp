import "server-only";
import { prisma } from "@/lib/prisma";
import { addDays, bjDateKey, dateFromKey, dateKeyOf, isDateKey, leaveOn, SHIFT_KINDS, SHIFT_LABELS, weekDates, weekStartOf, type LeaveKindKey, type ShiftKindKey } from "@/lib/attendance";
import { canManageAttendance, canViewTeamAttendance } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { canAccessStoreSafe, storeTableWhere } from "@/server/auth/scope";
import { writeAudit } from "@/server/audit";
import { type Db, withTx } from "@/server/db-tx";

// 排班（口径第 19 节）：店长给本店员工排每天的班（早、中、晚、休息），一周一屏，可以复制上周；
// 区域经理只看，总部全部能看能改；员工在“考勤打卡”里看自己的班。
// 按“那天在哪家店”算（2026-10-21 复查后定）：一格班记着那天是哪家店的；调了店的人，老店那几天的班新店改不了，老店的表上还看得到。
// 店长不能改自己今天和以前的班（会改掉自己的缺勤，找总部）；改今天以前的格子按格记日志：谁、哪天、原来 → 改成。

export class ScheduleError extends Error {}

/** 一次最多存多少格（一周 7 天 × 100 人） */
const MAX_CELLS = 700;
/** 往前最多改到上个月 1 号、往后最多排 90 天 */
const AHEAD_DAYS = 90;

/** 能排的日期范围：上个月 1 号 ～ 今天往后 90 天 */
export function editableRange(today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const prev = new Date(Date.UTC(y, m - 2, 1));
  return { from: dateKeyOf(prev), to: addDays(today, AHEAD_DAYS) };
}

async function loadStore(db: Db, user: CurrentUser, storeId: number) {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { id: true, code: true, name: true, regionId: true } });
  if (!store || !canAccessStoreSafe(user, store)) throw new ScheduleError("门店不存在或不在你的范围内");
  return store;
}

/** 门店里要排班的人：现在在这家店、在职的店员和店长 */
export async function storeStaff(db: Db, storeId: number) {
  return db.user.findMany({ where: { storeId, isActive: true, role: { in: ["STAFF", "STORE_MANAGER"] } }, orderBy: [{ role: "desc" }, { id: "asc" }], select: { id: true, name: true, role: true } });
}

/** 批了的请假（按人）：给排班表、考勤统计标“假” */
export async function approvedLeaves(db: Db, userIds: number[], from: string, to: string) {
  const rows = await db.leaveRequest.findMany({ where: { userId: { in: userIds }, status: "APPROVED", startDate: { lte: dateFromKey(to) }, endDate: { gte: dateFromKey(from) } }, select: { userId: true, kind: true, startDate: true, endDate: true } });
  const byUser = new Map<number, { kind: LeaveKindKey; start: string; end: string }[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ kind: r.kind, start: dateKeyOf(r.startDate), end: dateKeyOf(r.endDate) });
    byUser.set(r.userId, list);
  }
  return byUser;
}

export async function getWeekSchedule(user: CurrentUser, query: { storeId?: number; week?: string }, now = new Date()) {
  if (!canViewTeamAttendance(user.role)) throw new ScheduleError("排班表店长、区域经理和总部能看；自己的班在“考勤打卡”里看");
  const stores = await prisma.store.findMany({ where: { AND: [storeTableWhere(user), { isActive: true }] }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, regionId: true } });
  const storeId = query.storeId && stores.some((s) => s.id === query.storeId) ? query.storeId : (user.storeId ?? stores[0]?.id ?? null);
  const today = bjDateKey(now);
  const weekStart = weekStartOf(isDateKey(query.week) ? query.week : today);
  const dates = weekDates(weekStart);
  const empty = { cells: {}, elsewhere: {}, leaves: {}, canEdit: false, selfId: user.id, selfLocked: user.role === "STORE_MANAGER" };
  if (!storeId) return { stores, storeId: null, weekStart, dates, today, employees: [], ...empty, range: editableRange(today) };
  await loadStore(prisma, user, storeId);
  const current = await storeStaff(prisma, storeId);
  // 这周在这家店上过班、现在调走或停用了的人也列出来（只读）
  const weekRange = { gte: dateFromKey(dates[0]!), lte: dateFromKey(dates[6]!) };
  const formerIds = (await prisma.shiftSchedule.findMany({ where: { storeId, date: weekRange, userId: { notIn: current.map((e) => e.id) } }, distinct: ["userId"], select: { userId: true } })).map((r) => r.userId);
  const former = formerIds.length ? await prisma.user.findMany({ where: { id: { in: formerIds } }, orderBy: { id: "asc" }, select: { id: true, name: true, role: true, isActive: true } }) : [];
  const employees = [
    ...current.map((e) => ({ ...e, current: true, note: null as string | null })),
    ...former.map((e) => ({ id: e.id, name: e.name, role: e.role, current: false, note: e.isActive ? "已调走" : "已停用" })),
  ];
  const ids = employees.map((e) => e.id);
  const [shifts, leaves, storeNames] = await Promise.all([
    prisma.shiftSchedule.findMany({ where: { userId: { in: ids }, date: weekRange }, select: { userId: true, date: true, shift: true, storeId: true } }),
    approvedLeaves(prisma, ids, dates[0]!, dates[6]!),
    prisma.store.findMany({ select: { id: true, name: true } }),
  ]);
  const cells: Record<string, ShiftKindKey> = {};
  const elsewhere: Record<string, string> = {}; // 那天在别的店的班：只显示，这里改不了
  for (const s of shifts) {
    const key = `${s.userId}|${dateKeyOf(s.date)}`;
    if (s.storeId === storeId) cells[key] = s.shift;
    else elsewhere[key] = `${storeNames.find((x) => x.id === s.storeId)?.name ?? "别的店"} ${SHIFT_LABELS[s.shift]}`;
  }
  const leaveCells: Record<string, LeaveKindKey> = {};
  for (const e of employees) {
    for (const d of dates) {
      const kind = leaveOn(d, leaves.get(e.id) ?? []);
      if (kind) leaveCells[`${e.id}|${d}`] = kind;
    }
  }
  const canEdit = canManageAttendance(user.role) && (user.role === "HQ" || user.storeId === storeId);
  return { stores, storeId, weekStart, dates, today, employees, cells, elsewhere, leaves: leaveCells, canEdit, selfId: user.id, selfLocked: user.role === "STORE_MANAGER", range: editableRange(today) };
}

export type WeekSchedule = Awaited<ReturnType<typeof getWeekSchedule>>;

async function assertCanEdit(db: Db, user: CurrentUser, storeId: number) {
  if (!canManageAttendance(user.role)) throw new ScheduleError("排班只有店长和总部能改");
  if (user.role !== "HQ" && user.storeId !== storeId) throw new ScheduleError("店长只能排本店的班");
  return loadStore(db, user, storeId);
}

function assertInRange(date: string, today: string) {
  const range = editableRange(today);
  if (date < range.from || date > range.to) throw new ScheduleError(`只能排 ${range.from} 到 ${range.to} 之间的班`);
}

/** 存一批格子：shift 为空就是清掉这天的班 */
export async function saveSchedule(user: CurrentUser, input: { storeId: unknown; cells: unknown }, opts: { db?: Db; now?: Date } = {}) {
  const db = opts.db ?? prisma;
  const today = bjDateKey(opts.now ?? new Date());
  const storeId = Number(input.storeId);
  if (!Number.isInteger(storeId) || storeId <= 0) throw new ScheduleError("门店不对");
  if (!Array.isArray(input.cells) || input.cells.length === 0) throw new ScheduleError("没有要保存的");
  if (input.cells.length > MAX_CELLS) throw new ScheduleError(`一次最多保存 ${MAX_CELLS} 格`);
  const cells = (input.cells as { userId?: unknown; date?: unknown; shift?: unknown }[]).map((c) => {
    const userId = Number(c?.userId);
    const shift = c?.shift === null || c?.shift === "" ? null : (c?.shift as ShiftKindKey);
    if (!Number.isInteger(userId) || !isDateKey(c?.date) || (shift !== null && !SHIFT_KINDS.includes(shift))) throw new ScheduleError("排班数据不对");
    assertInRange(c.date, today);
    return { userId, date: c.date, shift };
  });
  if (user.role === "STORE_MANAGER" && cells.some((c) => c.userId === user.id && c.date <= today)) throw new ScheduleError("自己今天和以前的班不能改（会改掉自己的考勤），找总部改");
  return withTx(db, async (tx) => {
    await assertCanEdit(tx, user, storeId);
    const staff = await storeStaff(tx, storeId);
    const staffIds = new Set(staff.map((s) => s.id));
    if (cells.some((c) => !staffIds.has(c.userId))) throw new ScheduleError("有人不是这家店在职的员工，刷新后再排");
    const existing = await tx.shiftSchedule.findMany({ where: { OR: cells.map((c) => ({ userId: c.userId, date: dateFromKey(c.date) })) }, select: { userId: true, date: true, shift: true, storeId: true } });
    const before = new Map(existing.map((e) => [`${e.userId}|${dateKeyOf(e.date)}`, e]));
    const elsewhere = cells.find((c) => {
      const e = before.get(`${c.userId}|${c.date}`);
      return e && e.storeId !== storeId;
    });
    if (elsewhere) throw new ScheduleError(`${staff.find((x) => x.id === elsewhere.userId)?.name ?? ""} ${elsewhere.date} 是在别的店上的班，找那家店长或总部改`);
    const pastChanges: { userId: number; date: string; from: ShiftKindKey | null; to: ShiftKindKey | null }[] = [];
    for (const c of cells) {
      const date = dateFromKey(c.date);
      const from = before.get(`${c.userId}|${c.date}`)?.shift ?? null;
      if (from === c.shift) continue;
      if (c.shift === null) await tx.shiftSchedule.deleteMany({ where: { userId: c.userId, date } });
      else await tx.shiftSchedule.upsert({ where: { userId_date: { userId: c.userId, date } }, create: { storeId, userId: c.userId, date, shift: c.shift, updatedById: user.id }, update: { storeId, shift: c.shift, updatedById: user.id } });
      if (c.date < today) pastChanges.push({ userId: c.userId, date: c.date, from, to: c.shift });
    }
    const dates = cells.map((c) => c.date).sort();
    await writeAudit({ userId: user.id, action: "hr.schedule.save", entity: "store", entityId: storeId, detail: { cells: cells.length, from: dates[0], to: dates.at(-1) } }, tx);
    // 改已经过去的日子会改掉考勤（缺勤、加班），按格记清楚
    for (const p of pastChanges) {
      const name = staff.find((x) => x.id === p.userId)?.name ?? "";
      await writeAudit({ userId: user.id, action: "hr.schedule.change_past", entity: "user", entityId: p.userId, detail: { name, date: p.date, from: p.from ? SHIFT_LABELS[p.from] : "没排班", to: p.to ? SHIFT_LABELS[p.to] : "没排班", storeId } }, tx);
    }
    return cells.length;
  });
}

/** 复制上周：本周还空着的格子按上周同一天排；已经排了的不动 */
export async function copyLastWeek(user: CurrentUser, input: { storeId: unknown; week: unknown }, opts: { db?: Db; now?: Date } = {}) {
  const db = opts.db ?? prisma;
  const today = bjDateKey(opts.now ?? new Date());
  const storeId = Number(input.storeId);
  if (!Number.isInteger(storeId) || storeId <= 0 || !isDateKey(input.week)) throw new ScheduleError("参数不对");
  const weekStart = weekStartOf(input.week);
  const dates = weekDates(weekStart);
  assertInRange(dates[0]!, today);
  assertInRange(dates[6]!, today);
  return withTx(db, async (tx) => {
    await assertCanEdit(tx, user, storeId);
    const ids = (await storeStaff(tx, storeId)).map((s) => s.id);
    const [last, current] = await Promise.all([
      tx.shiftSchedule.findMany({ where: { userId: { in: ids }, date: { gte: dateFromKey(addDays(weekStart, -7)), lte: dateFromKey(addDays(weekStart, -1)) } } }),
      tx.shiftSchedule.findMany({ where: { userId: { in: ids }, date: { gte: dateFromKey(dates[0]!), lte: dateFromKey(dates[6]!) } }, select: { userId: true, date: true } }),
    ]);
    const taken = new Set(current.map((c) => `${c.userId}|${dateKeyOf(c.date)}`));
    // 只填明天起还空着的格子：今天和过去的日子补排班会凭空多出缺勤（今天的班可能已经过了）
    const data = last
      .filter((s) => s.storeId === storeId)
      .map((s) => ({ storeId, userId: s.userId, date: dateFromKey(addDays(dateKeyOf(s.date), 7)), shift: s.shift, updatedById: user.id }))
      .filter((s) => !taken.has(`${s.userId}|${dateKeyOf(s.date)}`))
      .filter((s) => dateKeyOf(s.date) > today);
    if (data.length === 0) throw new ScheduleError("上周没有排班，或者本周明天起都已经排好了");
    await tx.shiftSchedule.createMany({ data, skipDuplicates: true });
    await writeAudit({ userId: user.id, action: "hr.schedule.copy", entity: "store", entityId: storeId, detail: { week: weekStart, cells: data.length } }, tx);
    return data.length;
  });
}

/** 自己这一周的班（考勤打卡页、“我的”页） */
export async function getMyWeek(userId: number, now = new Date()) {
  const today = bjDateKey(now);
  const dates = weekDates(weekStartOf(today));
  const [shifts, leaves] = await Promise.all([
    prisma.shiftSchedule.findMany({ where: { userId, date: { gte: dateFromKey(dates[0]!), lte: dateFromKey(dates[6]!) } }, select: { date: true, shift: true } }),
    approvedLeaves(prisma, [userId], dates[0]!, dates[6]!),
  ]);
  return dates.map((d) => ({ date: d, shift: shifts.find((s) => dateKeyOf(s.date) === d)?.shift ?? null, leave: leaveOn(d, leaves.get(userId) ?? []), isToday: d === today }));
}
