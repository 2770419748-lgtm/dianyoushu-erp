import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { bjDateKey, dateFromKey, dateKeyOf, isMonthKey, monthDates } from "@/lib/attendance";
import { isValidFen } from "@/lib/limits";
import { computeSlip, daysInMonthOf, employedDaysOf } from "@/lib/payroll";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { lockRow } from "@/server/db-lock";
import { type Db, withTx } from "@/server/db-tx";
import { monthSummaries } from "./attendance-service";

// 提成和工资条（口径第 19 节）：总部配提成方案（销售额比例、每台主机、每份碎屏险延保），员工档案里选一个；
// 每月总部点“生成工资条”出草稿：应发 = 基本工资（入职、离职当月按在职天数折算）+ 提成 − 缺勤扣款 + 其他奖惩；
// 草稿能改奖惩、重算；发布后数字锁定、员工能看自己的；要改只能整月作废重算。工资条只给本人和总部看。
// 门店收支按“那天在哪家店”分摊：每张工资条记着这个月在每家店上了几天班。

export class PayrollError extends Error {}

const PAYROLL_LOCK_NS = -80; // 咨询锁命名空间（列表见 attendance-service.ts）：同一个月的生成排队
const MAX_ADJUST_FEN = 10_000_000; // 奖惩一笔最多 ±10 万元

export function canManagePayroll(role: CurrentUser["role"]): boolean {
  return role === "HQ";
}

function assertHq(user: CurrentUser) {
  if (!canManagePayroll(user.role)) throw new PayrollError("工资只有总部能管");
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function monthRange(month: string) {
  return { gte: dateFromKey(`${month}-01`), lte: dateFromKey(monthDates(month).at(-1)!) };
}

// ---------- 提成方案 ----------

export async function listPlans(db: Db = prisma) {
  const plans = await db.commissionPlan.findMany({ orderBy: [{ isActive: "desc" }, { id: "asc" }], include: { _count: { select: { profiles: true } } } });
  return plans.map((p) => ({ id: p.id, name: p.name, salesRateBp: p.salesRateBp, perDeviceFen: p.perDeviceFen, perServiceFen: p.perServiceFen, isActive: p.isActive, note: p.note, people: p._count.profiles }));
}

export type PlanRow = Awaited<ReturnType<typeof listPlans>>[number];

export async function savePlan(user: CurrentUser, input: { id?: unknown; name: unknown; salesRateBp: unknown; perDeviceFen: unknown; perServiceFen: unknown; isActive?: unknown; note?: unknown }, db: Db = prisma) {
  assertHq(user);
  const name = text(input.name, 30);
  if (!name) throw new PayrollError("给方案起个名字（比如“店员方案”）");
  const salesRateBp = Number(input.salesRateBp);
  if (!Number.isInteger(salesRateBp) || salesRateBp < 0 || salesRateBp > 10000) throw new PayrollError("销售额提成比例填 0～100%，最小到 0.01%");
  const perDeviceFen = Number(input.perDeviceFen);
  const perServiceFen = Number(input.perServiceFen);
  if (!Number.isInteger(perDeviceFen) || perDeviceFen < 0 || !isValidFen(perDeviceFen)) throw new PayrollError("每台主机的提成不对");
  if (!Number.isInteger(perServiceFen) || perServiceFen < 0 || !isValidFen(perServiceFen)) throw new PayrollError("每份碎屏险、延保的提成不对");
  const data = { name, salesRateBp, perDeviceFen, perServiceFen, isActive: input.isActive !== false, note: text(input.note, 100) || null };
  const id = input.id === undefined || input.id === null ? null : Number(input.id);
  return withTx(db, async (tx) => {
    const dup = await tx.commissionPlan.findFirst({ where: { name, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
    if (dup) throw new PayrollError("已经有同名的方案了");
    const plan = id ? await tx.commissionPlan.update({ where: { id }, data }) : await tx.commissionPlan.create({ data });
    await writeAudit({ userId: user.id, action: id ? "payroll.plan.update" : "payroll.plan.create", entity: "commission_plan", entityId: plan.id, detail: data }, tx);
    return plan.id;
  });
}

// ---------- 生成 ----------

/** 这个月每个人开单的销售额（扣掉退货）、卖了几台主机、几份碎屏险延保（扣掉退的）。按开单人算，作废的单不算 */
async function salesByPerson(db: Db, month: string): Promise<Map<number, { salesFen: number; deviceQty: number; serviceQty: number }>> {
  const r = monthRange(month);
  const [sales, refunds, sold, returned] = await Promise.all([
    db.$queryRaw<{ uid: number; v: bigint }[]>`SELECT salesperson_id AS uid, SUM(total_fen)::bigint AS v FROM sales_orders WHERE status = 'COMPLETED' AND biz_date BETWEEN ${r.gte} AND ${r.lte} GROUP BY 1`,
    db.$queryRaw<{ uid: number; v: bigint }[]>`SELECT o.salesperson_id AS uid, SUM(t.refund_fen)::bigint AS v FROM return_orders t JOIN sales_orders o ON o.id = t.sales_order_id WHERE t.biz_date BETWEEN ${r.gte} AND ${r.lte} GROUP BY 1`,
    db.$queryRaw<{ uid: number; devices: number; services: number }[]>`
      SELECT o.salesperson_id AS uid, COUNT(*) FILTER (WHERE i.device_id IS NOT NULL)::int AS devices, COALESCE(SUM(i.qty) FILTER (WHERE e.id IS NOT NULL), 0)::int AS services
      FROM sales_order_items i JOIN sales_orders o ON o.id = i.order_id LEFT JOIN service_entitlements e ON e.sales_order_item_id = i.id
      WHERE o.status = 'COMPLETED' AND o.biz_date BETWEEN ${r.gte} AND ${r.lte} GROUP BY 1`,
    db.$queryRaw<{ uid: number; devices: number; services: number }[]>`
      SELECT o.salesperson_id AS uid, COUNT(*) FILTER (WHERE ri.device_id IS NOT NULL)::int AS devices, COALESCE(SUM(ri.qty) FILTER (WHERE e.id IS NOT NULL), 0)::int AS services
      FROM return_order_items ri JOIN return_orders t ON t.id = ri.return_order_id JOIN sales_orders o ON o.id = t.sales_order_id LEFT JOIN service_entitlements e ON e.sales_order_item_id = ri.sales_item_id
      WHERE t.biz_date BETWEEN ${r.gte} AND ${r.lte} GROUP BY 1`,
  ]);
  const out = new Map<number, { salesFen: number; deviceQty: number; serviceQty: number }>();
  const row = (uid: number) => out.get(uid) ?? out.set(uid, { salesFen: 0, deviceQty: 0, serviceQty: 0 }).get(uid)!;
  for (const s of sales) row(s.uid).salesFen += Number(s.v);
  for (const s of refunds) row(s.uid).salesFen -= Number(s.v);
  for (const s of sold) {
    row(s.uid).deviceQty += s.devices;
    row(s.uid).serviceQty += s.services;
  }
  for (const s of returned) {
    row(s.uid).deviceQty -= s.devices;
    row(s.uid).serviceQty -= s.services;
  }
  return out;
}

/**
 * 这个月要发工资的人：入职日期不晚于月底，而且这个月在职（账号在用，或者离职日期在这个月或以后），
 * 或者这个月排过班、打过卡、开过单（停用了没记离职日期的也不漏）
 */
async function employeesOf(db: Db, month: string, sellers: number[]) {
  const r = monthRange(month);
  const [shifted, punched] = await Promise.all([
    db.shiftSchedule.findMany({ where: { date: r }, distinct: ["userId"], select: { userId: true } }),
    db.attendancePunch.findMany({ where: { date: r }, distinct: ["userId"], select: { userId: true } }),
  ]);
  const worked = [...new Set([...shifted.map((x) => x.userId), ...punched.map((x) => x.userId), ...sellers])];
  return db.user.findMany({
    where: {
      AND: [
        { OR: [{ profile: null }, { profile: { hireDate: null } }, { profile: { hireDate: { lte: r.lte } } }] },
        { OR: [{ isActive: true }, { profile: { leaveDate: { gte: r.gte } } }, { id: { in: worked } }] },
      ],
    },
    orderBy: [{ storeId: "asc" }, { role: "desc" }, { id: "asc" }],
    select: { id: true, name: true, isActive: true, storeId: true, profile: { select: { baseSalaryFen: true, hireDate: true, leaveDate: true, commissionPlan: true } } },
  });
}

/**
 * 生成这个月的工资条（草稿）：已经有草稿就重算（奖惩保留），已经发布了要先整月作废；作废以后重新生成，带上最近那份作废工资里的奖惩。
 * 只能生成这个月和以前的。缺勤天数、分店天数只算在职那几天（入职日到离职日）；这个月一天都不在职的（比如上个月走的人只剩退货冲回）不生成。
 */
export async function generatePayroll(user: CurrentUser, month: unknown, opts: { db?: Db; now?: Date } = {}) {
  assertHq(user);
  if (!isMonthKey(month)) throw new PayrollError("选一下月份");
  const now = opts.now ?? new Date();
  if (month > bjDateKey(now).slice(0, 7)) throw new PayrollError("还没到的月份不能生成");
  return withTx(opts.db ?? prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PAYROLL_LOCK_NS}::int, hashtext(${month}::text))`;
    let open = await tx.payrollRun.findFirst({ where: { month, status: { not: "VOIDED" } } });
    if (open) {
      // 先锁住这份工资再看状态：和同时进行的发布、作废排队（发布了就不能再重算，作废了就当没有）
      await lockRow(tx, "payroll_runs", open.id);
      open = await tx.payrollRun.findUniqueOrThrow({ where: { id: open.id } });
      if (open.status === "PUBLISHED") throw new PayrollError(`${month} 的工资已经发布了，要改先整月作废再重新生成`);
      if (open.status === "VOIDED") open = null;
    }
    const kept = new Map<number, { adjustmentFen: number; adjustmentNote: string | null }>();
    let carried = 0; // 从作废的那份带过来几笔奖惩
    if (open) {
      for (const s of await tx.payrollSlip.findMany({ where: { runId: open.id }, select: { userId: true, adjustmentFen: true, adjustmentNote: true } })) kept.set(s.userId, s);
      await tx.payrollSlip.deleteMany({ where: { runId: open.id } });
    } else {
      // 整月作废是改已发布工资的唯一办法：重新生成时把最近那份作废工资里的奖惩带过来（要改再在草稿里改）
      const lastVoided = await tx.payrollRun.findFirst({ where: { month, status: "VOIDED" }, orderBy: { id: "desc" }, select: { id: true } });
      if (lastVoided) {
        for (const s of await tx.payrollSlip.findMany({ where: { runId: lastVoided.id, adjustmentFen: { not: 0 } }, select: { userId: true, adjustmentFen: true, adjustmentNote: true } })) kept.set(s.userId, s);
        carried = kept.size;
      }
    }
    const sales = await salesByPerson(tx, month);
    const monthEnd = monthDates(month).at(-1)!;
    const keyOf = (d: Date | null | undefined) => (d ? dateKeyOf(d) : null);
    const everyone = await employeesOf(tx, month, [...sales.keys()]);
    // 账号在用、档案里却有这个月或以前的离职日期：底薪按离职日期折算了（更早的连工资条都不生成），多半是重新启用时忘了清，提醒核对
    const stale = everyone.filter((p) => p.isActive && p.profile?.leaveDate && dateKeyOf(p.profile.leaveDate) <= monthEnd).map((p) => p.name);
    // 这个月一天都不在职的不发（上个月走的人这个月只有退货冲回、下个月才来的人）
    const people = everyone.filter((p) => employedDaysOf(month, keyOf(p.profile?.hireDate), keyOf(p.profile?.leaveDate)) > 0);
    const windows = new Map(
      people.map((p) => {
        const hire = keyOf(p.profile?.hireDate);
        const leave = keyOf(p.profile?.leaveDate);
        return [p.id, { from: hire && hire > `${month}-01` ? hire : `${month}-01`, to: leave && leave < monthEnd ? leave : monthEnd }];
      }),
    );
    const attendance = await monthSummaries(tx, people.map((p) => p.id), month, now, windows);
    const run = open
      ? await tx.payrollRun.update({ where: { id: open.id }, data: { generatedById: user.id, generatedAt: now } })
      : await tx.payrollRun.create({ data: { month, generatedById: user.id, generatedAt: now } });
    const slips = people.map((p) => {
      const s = sales.get(p.id) ?? { salesFen: 0, deviceQty: 0, serviceQty: 0 };
      const a = attendance.get(p.id);
      const adj = kept.get(p.id) ?? { adjustmentFen: 0, adjustmentNote: null };
      const plan = p.profile?.commissionPlan ?? null;
      const n = computeSlip({
        month,
        baseSalaryFen: p.profile?.baseSalaryFen ?? 0,
        hireDate: p.profile?.hireDate ? dateKeyOf(p.profile.hireDate) : null,
        leaveDate: p.profile?.leaveDate ? dateKeyOf(p.profile.leaveDate) : null,
        absentDays: a?.summary.absent ?? 0,
        ...s,
        plan,
        adjustmentFen: adj.adjustmentFen,
      });
      return {
        runId: run.id,
        userId: p.id,
        storeId: p.storeId,
        planName: plan?.name ?? null,
        baseSalaryFen: p.profile?.baseSalaryFen ?? 0,
        absentDays: a?.summary.absent ?? 0,
        ...s,
        ...n,
        adjustmentFen: adj.adjustmentFen,
        adjustmentNote: adj.adjustmentNote,
        storeDays: Object.fromEntries(a?.storeDays ?? []) as Prisma.InputJsonValue,
      };
    });
    if (slips.length > 0) await tx.payrollSlip.createMany({ data: slips });
    const grossFen = slips.reduce((sum, x) => sum + x.grossFen, 0);
    await tx.payrollRun.update({ where: { id: run.id }, data: { slipCount: slips.length, grossFen } });
    await writeAudit({ userId: user.id, action: open ? "payroll.regenerate" : "payroll.generate", entity: "payroll_run", entityId: run.id, detail: { month, slips: slips.length, grossFen, carried, stale } }, tx);
    return { runId: run.id, slipCount: slips.length, grossFen, carried, stale };
  });
}

/** 草稿里改一个人的奖惩（正数奖、负数罚），不为 0 要写原因 */
export async function setAdjustment(user: CurrentUser, slipId: number, input: { adjustmentFen: unknown; note: unknown }, db: Db = prisma) {
  assertHq(user);
  const adjustmentFen = Number(input.adjustmentFen);
  if (!Number.isInteger(adjustmentFen) || Math.abs(adjustmentFen) > MAX_ADJUST_FEN) throw new PayrollError("奖惩金额不对（最小到分，最多 ±10 万元）");
  const note = text(input.note, 100) || null;
  if (adjustmentFen !== 0 && !note) throw new PayrollError("写一下奖惩原因");
  return withTx(db, async (tx) => {
    const head = await tx.payrollSlip.findUnique({ where: { id: slipId }, select: { runId: true } });
    if (!head) throw new PayrollError("工资条不存在");
    // 先锁整月再读工资条：同一张同时改两次，后一次读到的是前一次改完的，合计不会差
    if (!(await lockRow(tx, "payroll_runs", head.runId))) throw new PayrollError("工资不存在");
    const slip = await tx.payrollSlip.findUnique({ where: { id: slipId } });
    if (!slip) throw new PayrollError("工资条不存在（可能刚重算过，刷新再改）");
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: head.runId } });
    if (run.status !== "DRAFT") throw new PayrollError("发布了的工资不能改，要改先整月作废重算");
    const grossFen = slip.baseFen + slip.commissionFen - slip.absenceDeductionFen + adjustmentFen;
    await tx.payrollSlip.update({ where: { id: slipId }, data: { adjustmentFen, adjustmentNote: adjustmentFen === 0 ? null : note, grossFen } });
    await tx.payrollRun.update({ where: { id: run.id }, data: { grossFen: run.grossFen - slip.grossFen + grossFen } });
    await writeAudit({ userId: user.id, action: "payroll.adjust", entity: "payroll_slip", entityId: slipId, detail: { month: run.month, userId: slip.userId, before: slip.adjustmentFen, after: adjustmentFen, note } }, tx);
  });
}

/** 发布：数字锁定，给每个人发一条消息（小铃铛）让他看自己的工资条。月份过完了（下月 1 号起）才能发布：没过完的提成、考勤还会变 */
export async function publishPayroll(user: CurrentUser, runId: number, db: Db = prisma, now = new Date()) {
  assertHq(user);
  return withTx(db, async (tx) => {
    if (!(await lockRow(tx, "payroll_runs", runId))) throw new PayrollError("工资不存在");
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== "DRAFT") throw new PayrollError(run.status === "PUBLISHED" ? "已经发布过了" : "作废了的不能发布");
    if (run.month >= bjDateKey(now).slice(0, 7)) throw new PayrollError(`${run.month} 还没过完，下月 1 号起才能发布（提成、考勤还会变）`);
    if (run.slipCount === 0) throw new PayrollError("没有工资条，不用发布");
    await tx.payrollRun.update({ where: { id: runId }, data: { status: "PUBLISHED", publishedById: user.id, publishedAt: new Date() } });
    const slips = await tx.payrollSlip.findMany({ where: { runId }, select: { userId: true } });
    await tx.notification.createMany({ data: slips.map((s) => ({ userId: s.userId, title: `工资条：${run.month}`, body: `${run.month} 的工资条发布了，点开看自己的明细`, link: `/hr/payroll?month=${run.month}` })) });
    await writeAudit({ userId: user.id, action: "payroll.publish", entity: "payroll_run", entityId: runId, detail: { month: run.month, slips: run.slipCount, grossFen: run.grossFen } }, tx);
  });
}

/** 整月作废（草稿、已发布都行）：写原因；作废了再重新生成 */
export async function voidPayroll(user: CurrentUser, runId: number, reason: unknown, db: Db = prisma) {
  assertHq(user);
  const why = text(reason, 100);
  if (!why) throw new PayrollError("写一下为什么作废");
  return withTx(db, async (tx) => {
    if (!(await lockRow(tx, "payroll_runs", runId))) throw new PayrollError("工资不存在");
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status === "VOIDED") throw new PayrollError("已经作废了");
    await tx.payrollRun.update({ where: { id: runId }, data: { status: "VOIDED", voidedById: user.id, voidedAt: new Date(), voidReason: why } });
    await tx.notification.deleteMany({ where: { link: `/hr/payroll?month=${run.month}`, title: `工资条：${run.month}` } });
    await writeAudit({ userId: user.id, action: "payroll.void", entity: "payroll_run", entityId: runId, detail: { month: run.month, wasPublished: run.status === "PUBLISHED", reason: why } }, tx);
  });
}

// ---------- 查看 ----------

/** 总部：选一个月看工资（草稿、已发布、作废记录）和提成方案；其他人：自己已发布的工资条 */
export async function getPayrollPage(user: CurrentUser, query: { month?: string }, now = new Date(), db: Db = prisma) {
  const thisMonth = bjDateKey(now).slice(0, 7);
  const [y, m] = thisMonth.split("-").map(Number) as [number, number];
  const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const month = isMonthKey(query.month) && query.month <= thisMonth ? query.month : lastMonth;
  const slipInclude = { user: { select: { name: true, role: true, isActive: true } }, store: { select: { code: true, name: true } } } as const;
  if (!canManagePayroll(user.role)) {
    const mine = await db.payrollSlip.findMany({ where: { userId: user.id, run: { status: "PUBLISHED" } }, include: { run: { select: { month: true, publishedAt: true } }, ...slipInclude }, orderBy: { run: { month: "desc" } }, take: 24 });
    return { manage: false as const, month, thisMonth, mine: mine.map((s) => ({ ...s, month: s.run.month })) };
  }
  const runs = await db.payrollRun.findMany({ where: { month }, orderBy: { id: "desc" }, include: { slips: { include: slipInclude, orderBy: [{ storeId: "asc" }, { userId: "asc" }] } } });
  const current = runs.find((r) => r.status !== "VOIDED") ?? null;
  // 账号在用、档案里却有这个月或以前的离职日期：工资会按离职日期折算甚至不生成，页面上一直提醒到改好为止
  const staleLeave = await db.user.findMany({ where: { isActive: true, profile: { leaveDate: { lte: monthRange(month).lte } } }, select: { id: true, name: true, profile: { select: { leaveDate: true } } }, orderBy: { id: "asc" } });
  return {
    manage: true as const,
    month,
    thisMonth,
    daysInMonth: daysInMonthOf(month),
    run: current,
    staleLeave: staleLeave.map((u) => ({ id: u.id, name: u.name, leaveDate: dateKeyOf(u.profile!.leaveDate!) })),
    voided: runs.filter((r) => r.status === "VOIDED").map((r) => ({ id: r.id, voidedAt: r.voidedAt, voidReason: r.voidReason, grossFen: r.grossFen })),
    plans: await listPlans(db),
  };
}

export type PayrollPage = Awaited<ReturnType<typeof getPayrollPage>>;

/**
 * 门店收支用：某个月已发布的工资按门店分摊（按那天在哪家店）：每张工资条按这个月在各家店上班的天数分；
 * 没排过班的（比如总部的人、请了整月假的）算到他生成工资时的门店，没门店的算总部（null）。
 */
export async function payrollCostByStore(db: Db, month: string): Promise<{ published: boolean; byStore: Map<number | null, number> }> {
  if (!isMonthKey(month)) throw new PayrollError("月份不对，格式是 2026-10");
  const run = await db.payrollRun.findFirst({ where: { month, status: "PUBLISHED" }, include: { slips: { select: { grossFen: true, storeId: true, storeDays: true } } } });
  const byStore = new Map<number | null, number>();
  if (!run) return { published: false, byStore };
  const add = (store: number | null, fen: number) => byStore.set(store, (byStore.get(store) ?? 0) + fen);
  for (const s of run.slips) {
    const days = Object.entries((s.storeDays ?? {}) as Record<string, number>).filter(([, n]) => n > 0);
    const total = days.reduce((sum, [, n]) => sum + n, 0);
    if (total === 0) {
      add(s.storeId, s.grossFen);
      continue;
    }
    // 按天数分，分不尽的零头给天数最多的那家
    let left = s.grossFen;
    const sorted = [...days].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
    for (const [store, n] of sorted.slice(1)) {
      const part = Math.trunc((s.grossFen * n) / total);
      add(Number(store), part);
      left -= part;
    }
    add(Number(sorted[0]![0]), left);
  }
  return { published: true, byStore };
}
