import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { addDays, bjDateKey, bjDateTime, dateFromKey, weekDates, weekStartOf } from "@/lib/attendance";
import type { CurrentUser } from "@/server/auth/current-user";
import { approveRequest, cancelPendingOaFor, getApproval, rejectRequest } from "@/server/approval/approval-service";
import { submitExpense } from "@/server/finance/expense-service";
import { addManualPunch, monthStats, punch, userMonthDetail, userMonthSummary } from "@/server/hr/attendance-service";
import { cancelLeave, submitLeave } from "@/server/hr/leave-service";
import { copyLastWeek, removeFutureShiftsFor, saveSchedule } from "@/server/hr/schedule-service";
import { setUserActive } from "@/server/org/org-service";

// 排班、考勤、请假（口径第 19 节，连本机库，事务回滚不留数据）：请假走审批（一级、两级、驳回、撤回、发起人停用）、
// 不挂门店的审批单谁能看能批；排班的范围；打卡、补卡的规则。测试用的人都在事务里新建，不碰演示数据。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type Store = { id: number; regionId: number };
let stores: { a: Store; b: Store } | null = null;
let hq: CurrentUser | null = null;

const today = bjDateKey(new Date());
const at = (date: string, hhmm: string, ss = 0) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return bjDateTime(date, h * 60 + m + ss / 60);
};
const NIGHT = at(today, "23:00");

const asUser = (u: { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean }) => ({ ...u, store: null, region: null }) as CurrentUser;

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 60000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

beforeAll(async () => {
  try {
    const list = await prisma.store.findMany({ where: { isActive: true }, orderBy: { id: "asc" } });
    const a = list[0];
    const b = list.find((s) => s.regionId !== a?.regionId) ?? list[1];
    const h = await prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } });
    if (a && b && h) {
      stores = { a, b };
      hq = asUser(h);
    }
  } catch {
    stores = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 在事务里建一批测试用的人 */
async function people(tx: Prisma.TransactionClient) {
  const { a, b } = stores!;
  const mk = (key: string, role: CurrentUser["role"], storeId: number | null, regionId: number | null = null) =>
    tx.user.create({ data: { username: `hrtest_${key}`, passwordHash: "x", name: `人事测试${key}`, role, storeId, regionId } }).then(asUser);
  return {
    mgrA: await mk("mgrA", "STORE_MANAGER", a.id),
    staffA1: await mk("staffA1", "STAFF", a.id),
    staffA2: await mk("staffA2", "STAFF", a.id),
    mgrB: await mk("mgrB", "STORE_MANAGER", b.id),
    staffB: await mk("staffB", "STAFF", b.id),
    regional: await mk("regional", "REGIONAL_MANAGER", null, a.regionId),
    hq2: await mk("hq2", "HQ", null),
  };
}

const leave = (startOffset: number, days: number, kind: "PERSONAL" | "SICK" | "ANNUAL" | "COMPENSATORY" = "PERSONAL") => ({ kind, startDate: addDays(today, startOffset), endDate: addDays(today, startOffset + days - 1), reason: "测试请假" });

describe("请假和两级审批（连本机库，事务回滚）", () => {
  it("店员请 2 天：店长批了就生效；重叠的不让提交", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const r = await submitLeave(p.staffA1, leave(3, 2), { db: tx });
      expect(r.chain).toEqual(["STORE_MANAGER"]);
      const row = await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } });
      const approval = await tx.approvalRequest.findUniqueOrThrow({ where: { id: row.approvalRequestId! } });
      expect(approval).toMatchObject({ action: "LEAVE", storeId: stores!.a.id, approverRole: "STORE_MANAGER", step: 1, status: "PENDING", amountFen: 0 });
      await expect(submitLeave(p.staffA1, leave(4, 1), { db: tx })).rejects.toThrow("重叠");
      await expect(approveRequest(p.mgrB, approval.id, "", tx)).rejects.toThrow(); // 别家店长
      expect(await approveRequest(p.mgrA, approval.id, "", tx)).toMatchObject({ executed: true, resultId: r.id });
      expect((await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("APPROVED");
      await expect(submitLeave(p.staffA1, leave(4, 1), { db: tx })).rejects.toThrow("重叠"); // 已批的也算
      await expect(submitLeave(p.staffA1, { ...leave(10, 1), reason: "" }, { db: tx })).rejects.toThrow("事由");
      await expect(submitLeave(p.staffA1, leave(-40, 1), { db: tx })).rejects.toThrow("补请");
      await expect(submitLeave(p.staffA1, leave(10, 31), { db: tx })).rejects.toThrow("最多请");
    });
  });

  it("请 3 天：店长批完转总部、只记一笔，总部批了才生效；总部直接批第一级就是最后一级", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const r = await submitLeave(p.staffA1, leave(5, 3, "ANNUAL"), { db: tx });
      expect(r.chain).toEqual(["STORE_MANAGER", "HQ"]);
      const approvalId = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).approvalRequestId!;
      expect(await approveRequest(p.mgrA, approvalId, "同意，交接好", tx)).toEqual({ executed: false, forwardedTo: "HQ" });
      const mid = await tx.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
      expect(mid).toMatchObject({ status: "PENDING", step: 2, approverRole: "HQ", decidedById: null });
      expect(mid.stepLog).toEqual([expect.objectContaining({ step: 1, role: "STORE_MANAGER", userId: p.mgrA.id, note: "同意，交接好" })]);
      expect((await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PENDING");
      await expect(approveRequest(p.mgrA, approvalId, "", tx)).rejects.toThrow("批过前一级");
      const detail = await getApproval(me, approvalId, tx);
      expect(detail?.can.decide).toBe(true);
      expect(detail?.stepLog).toHaveLength(1);
      expect(await approveRequest(me, approvalId, "", tx)).toMatchObject({ executed: true });
      expect((await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("APPROVED");

      const r2 = await submitLeave(p.staffA2, leave(5, 4), { db: tx });
      const id2 = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: r2.id } })).approvalRequestId!;
      expect(await approveRequest(me, id2, "", tx)).toMatchObject({ executed: true }); // 总部直接批第一级
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: id2 } })).status).toBe("EXECUTED");
    });
  });

  it("在哪一级驳回都结束；撤回；发起人停用了算没做成、请假单撤回", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const r = await submitLeave(p.staffA1, leave(5, 3), { db: tx });
      const id = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).approvalRequestId!;
      await approveRequest(p.mgrA, id, "", tx);
      await rejectRequest(me, id, "那几天人手不够", tx);
      expect((await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("REJECTED");

      const r2 = await submitLeave(p.staffA1, leave(9, 1), { db: tx }); // 驳回的不算重叠
      await cancelLeave(p.staffA1, r2.id, tx);
      expect((await tx.leaveRequest.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe("CANCELLED");
      await expect(cancelLeave(p.staffA1, r2.id, tx)).rejects.toThrow("处理过了");
      await expect(cancelLeave(p.staffA2, r.id, tx)).rejects.toThrow("自己");

      const r3 = await submitLeave(p.staffA2, leave(2, 1), { db: tx });
      const id3 = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: r3.id } })).approvalRequestId!;
      await tx.user.update({ where: { id: p.staffA2.id }, data: { isActive: false } });
      expect(await approveRequest(p.mgrA, id3, "", tx)).toMatchObject({ executed: false, error: expect.stringContaining("停用") });
      expect((await tx.leaveRequest.findUniqueOrThrow({ where: { id: r3.id } })).status).toBe("CANCELLED");
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: id3 } })).status).toBe("FAILED");
    });
  });

  it("店长的假直接总部批；区域经理的假不挂门店，只有发起人和总部看得到", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const r = await submitLeave(p.mgrA, leave(2, 1), { db: tx });
      expect(r.chain).toEqual(["HQ"]);
      const id = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).approvalRequestId!;
      await expect(approveRequest(p.mgrA, id, "", tx)).rejects.toThrow("自己");
      await expect(approveRequest(p.mgrB, id, "", tx)).rejects.toThrow();

      const r2 = await submitLeave(p.regional, leave(2, 2), { db: tx }); // 区域经理没有门店：不挂门店、直接总部批
      const id2 = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: r2.id } })).approvalRequestId!;
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: id2 } })).storeId).toBeNull();
      await expect(getApproval(p.staffB, id2, tx)).rejects.toThrow("没有权限");
      await expect(getApproval(p.mgrA, id2, tx)).rejects.toThrow("没有权限");
      expect((await getApproval(p.regional, id2, tx))?.can).toEqual({ decide: false, cancel: true });
      expect((await getApproval(me, id2, tx))?.can.decide).toBe(true);
      await expect(approveRequest(p.mgrA, id2, "", tx)).rejects.toThrow("总部");
      expect(await approveRequest(me, id2, "", tx)).toMatchObject({ executed: true });
    });
  });
});

describe("排班（连本机库，事务回滚）", () => {
  it("店长排本店、复制上周；别家、区域经理、不是本店的人、超出范围都不行", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const { a, b } = stores!;
      const base = weekStartOf(addDays(today, 28)); // 演示数据只排到两周后，这里往后挪开
      const n = await saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.staffA1.id, date: base, shift: "MORNING" }, { userId: p.staffA1.id, date: addDays(base, 1), shift: "EVENING" }, { userId: p.staffA2.id, date: base, shift: null }] }, { db: tx });
      expect(n).toBe(3);
      expect(await tx.shiftSchedule.count({ where: { userId: p.staffA1.id, date: { gte: dateFromKey(base) } } })).toBe(2);
      await saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.staffA1.id, date: base, shift: "MIDDLE" }] }, { db: tx }); // 改
      expect((await tx.shiftSchedule.findFirstOrThrow({ where: { userId: p.staffA1.id, date: dateFromKey(base) } })).shift).toBe("MIDDLE");

      await expect(saveSchedule(p.mgrA, { storeId: b.id, cells: [{ userId: p.staffB.id, date: base, shift: "MORNING" }] }, { db: tx })).rejects.toThrow("本店");
      await expect(saveSchedule(p.regional, { storeId: a.id, cells: [{ userId: p.staffA1.id, date: base, shift: "MORNING" }] }, { db: tx })).rejects.toThrow("店长和总部");
      await expect(saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.staffB.id, date: base, shift: "MORNING" }] }, { db: tx })).rejects.toThrow("不是这家店");
      await expect(saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.staffA1.id, date: addDays(today, 120), shift: "MORNING" }] }, { db: tx })).rejects.toThrow("只能排");
      await expect(saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.staffA1.id, date: base, shift: "NIGHT" }] }, { db: tx })).rejects.toThrow("不对");

      expect(await copyLastWeek(p.mgrA, { storeId: a.id, week: addDays(base, 7) }, { db: tx })).toBe(2);
      expect((await tx.shiftSchedule.findFirstOrThrow({ where: { userId: p.staffA1.id, date: dateFromKey(addDays(base, 8)) } })).shift).toBe("EVENING");
      await expect(copyLastWeek(p.mgrA, { storeId: a.id, week: addDays(base, 7) }, { db: tx })).rejects.toThrow("都已经排好了");
      expect(await copyLastWeek(hq!, { storeId: b.id, week: addDays(base, 7) }, { db: tx }).catch((e: Error) => e.message)).toContain("上周没有排班"); // 总部能排别家，只是这家上周没排
    });
  });
});

describe("打卡和补卡（连本机库，事务回滚）", () => {
  it("上班卡一天一次，下班卡一分钟内不能连打；按班算迟到；月度统计", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      await tx.shiftSchedule.create({ data: { storeId: stores!.a.id, userId: p.staffA1.id, date: dateFromKey(today), shift: "MORNING", updatedById: p.mgrA.id } });
      expect((await punch(p.staffA1, "IN", { db: tx, now: at(today, "09:20") })).label).toContain("迟到 20 分钟");
      await expect(punch(p.staffA1, "IN", { db: tx, now: at(today, "09:30") })).rejects.toThrow("已经打过上班卡");
      await punch(p.staffA1, "OUT", { db: tx, now: at(today, "17:01") });
      await expect(punch(p.staffA1, "OUT", { db: tx, now: at(today, "17:01", 30) })).rejects.toThrow("刚打过");
      await punch(p.staffA1, "OUT", { db: tx, now: at(today, "17:30") });
      await expect(punch(p.staffA1, "LUNCH", { db: tx })).rejects.toThrow("类型");
      const s = await userMonthSummary(tx, p.staffA1.id, today.slice(0, 7), NIGHT);
      expect(s).toMatchObject({ late: 1, attended: 1, early: 0, missing: 0 });
      expect(s.scheduled).toBeGreaterThanOrEqual(1);
    });
  });

  it("补卡：店长给本店员工补、要写原因、记日志；不能给自己补、别家的人、还没到的时间；区域经理不能补", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const input = { userId: p.staffA1.id, date: today, kind: "OUT", time: "17:00", note: "忘打下班卡，看了监控" };
      await addManualPunch(p.mgrA, input, { db: tx, now: NIGHT });
      expect(await tx.attendancePunch.findFirstOrThrow({ where: { userId: p.staffA1.id, manual: true } })).toMatchObject({ kind: "OUT", note: input.note, createdById: p.mgrA.id });
      expect(await tx.auditLog.count({ where: { action: "attendance.manual", entityId: String(p.staffA1.id) } })).toBe(1);
      await expect(addManualPunch(p.mgrA, { ...input, note: "" }, { db: tx, now: NIGHT })).rejects.toThrow("原因");
      await expect(addManualPunch(p.mgrA, { ...input, userId: p.mgrA.id }, { db: tx, now: NIGHT })).rejects.toThrow("自己");
      await expect(addManualPunch(p.mgrA, { ...input, userId: p.staffB.id }, { db: tx, now: NIGHT })).rejects.toThrow("本店");
      await expect(addManualPunch(p.mgrA, input, { db: tx, now: at(today, "10:00") })).rejects.toThrow("还没到");
      await expect(addManualPunch(p.mgrA, { ...input, time: "25:00" }, { db: tx, now: NIGHT })).rejects.toThrow("时间");
      await expect(addManualPunch(p.regional, input, { db: tx, now: NIGHT })).rejects.toThrow("店长和总部");
      await addManualPunch(hq!, { ...input, userId: p.staffB.id }, { db: tx, now: NIGHT }); // 总部能给任何店补
    });
  });
});

describe("8b 复查后补（连本机库，事务回滚）", () => {
  it("店长不能改自己今天和以前的班；改今天以前的格子按格记日志；别的店的班这里改不了", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const { a, b } = stores!;
      const yesterday = addDays(today, -1);
      await expect(saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.mgrA.id, date: today, shift: "OFF" }] }, { db: tx })).rejects.toThrow("自己今天和以前的班不能改");
      expect(await saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.mgrA.id, date: addDays(today, 3), shift: "MORNING" }] }, { db: tx })).toBe(1); // 以后的自己照常排
      await saveSchedule(hq!, { storeId: a.id, cells: [{ userId: p.mgrA.id, date: yesterday, shift: "OFF" }] }, { db: tx }); // 总部能改

      await tx.shiftSchedule.create({ data: { storeId: a.id, userId: p.staffA1.id, date: dateFromKey(yesterday), shift: "MIDDLE", updatedById: p.mgrA.id } });
      await saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.staffA1.id, date: yesterday, shift: "OFF" }] }, { db: tx });
      const log = await tx.auditLog.findFirstOrThrow({ where: { action: "hr.schedule.change_past", entityId: String(p.staffA1.id) } });
      expect(log.detail).toMatchObject({ date: yesterday, from: "中班", to: "休息", name: "人事测试staffA1" });

      await tx.shiftSchedule.create({ data: { storeId: b.id, userId: p.staffA2.id, date: dateFromKey(addDays(today, -2)), shift: "MORNING", updatedById: p.mgrB.id } });
      await expect(saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.staffA2.id, date: addDays(today, -2), shift: "OFF" }] }, { db: tx })).rejects.toThrow("别的店");
    });
  });

  it("复制上周只填今天以后的空格子（过去的日子补排班会凭空多出缺勤）", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const week = weekStartOf(today);
      for (const d of weekDates(addDays(week, -7))) await tx.shiftSchedule.create({ data: { storeId: stores!.a.id, userId: p.staffA2.id, date: dateFromKey(d), shift: "MORNING", updatedById: p.mgrA.id } });
      const dates = weekDates(week);
      if (dates[6]! <= today) return; // 今天是周日，本周没有以后的日子
      await copyLastWeek(p.mgrA, { storeId: stores!.a.id, week }, { db: tx });
      const copied = await tx.shiftSchedule.findMany({ where: { userId: p.staffA2.id, date: { gte: dateFromKey(dates[0]!), lte: dateFromKey(dates[6]!) } }, select: { date: true }, orderBy: { date: "asc" } });
      expect(copied.map((c) => c.date.toISOString().slice(0, 10))).toEqual(dates.filter((d) => d > today));
    });
  });

  it("补卡记那天的门店，只有那家店的店长能补", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const yesterday = addDays(today, -1);
      await tx.shiftSchedule.create({ data: { storeId: stores!.b.id, userId: p.staffA1.id, date: dateFromKey(yesterday), shift: "MORNING", updatedById: p.mgrB.id } }); // 调店前那天在 B 店
      const input = { userId: p.staffA1.id, date: yesterday, kind: "IN", time: "09:00", note: "忘打卡" };
      await expect(addManualPunch(p.mgrA, input, { db: tx, now: NIGHT })).rejects.toThrow("那天在本店上班");
      await addManualPunch(p.mgrB, input, { db: tx, now: NIGHT });
      expect((await tx.attendancePunch.findFirstOrThrow({ where: { userId: p.staffA1.id, manual: true } })).storeId).toBe(stores!.b.id);
    });
  });

  it("月度统计按那天在哪家店算；调走、停用的人在他上过班的月份照样列出来", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const { a, b } = stores!;
      const [y, m] = today.split("-").map(Number) as [number, number];
      const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
      // staffA1 上个月 1 号在 A 店、2 号在 B 店，都没打卡（缺勤）；staffA2 上个月在 A 店上过班，现在停用了
      await tx.shiftSchedule.create({ data: { storeId: a.id, userId: p.staffA1.id, date: dateFromKey(prev + "-01"), shift: "MORNING", updatedById: p.mgrA.id } });
      await tx.shiftSchedule.create({ data: { storeId: b.id, userId: p.staffA1.id, date: dateFromKey(prev + "-02"), shift: "MORNING", updatedById: p.mgrB.id } });
      await tx.shiftSchedule.create({ data: { storeId: a.id, userId: p.staffA2.id, date: dateFromKey(prev + "-03"), shift: "MORNING", updatedById: p.mgrA.id } });
      await tx.user.update({ where: { id: p.staffA2.id }, data: { isActive: false } });

      const statsA = await monthStats(p.mgrA, { month: prev }, NIGHT, tx);
      expect(statsA.rows.find((r) => r.userId === p.staffA1.id)).toMatchObject({ note: null, summary: { scheduled: 1, absent: 1 } });
      expect(statsA.rows.find((r) => r.userId === p.staffA2.id)).toMatchObject({ note: "已停用", summary: { scheduled: 1, absent: 1 } });
      const statsB = await monthStats(p.mgrB, { month: prev }, NIGHT, tx);
      expect(statsB.rows.find((r) => r.userId === p.staffA1.id)).toMatchObject({ note: "已调走", summary: { scheduled: 1, absent: 1 } });
      const detail = await userMonthDetail(p.mgrB, p.staffA1.id, prev, NIGHT, tx);
      expect(detail.days.find((d) => d.date === prev + "-01")).toMatchObject({ label: "在别的店", absent: false });
      expect(detail.summary.absent).toBe(1);
      expect((await userMonthDetail(hq!, p.staffA1.id, prev, NIGHT, tx)).summary.absent).toBe(2); // 总部看整月
      expect(await userMonthSummary(tx, p.staffA1.id, prev, NIGHT)).toMatchObject({ absent: 2 }); // 工资按人算整月
    });
  });

  it("总部本人的请假、报销提交就算通过；调店、停用时审批中的请假自动撤回，报销照原来的门店批下去", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const hqLeave = await submitLeave(p.hq2, leave(5, 2), { db: tx });
      expect(hqLeave.autoApproved).toBe(true);
      expect((await tx.leaveRequest.findUniqueOrThrow({ where: { id: hqLeave.id } })).status).toBe("APPROVED");
      const hqApproval = await tx.approvalRequest.findFirstOrThrow({ where: { requestNo: hqLeave.requestNo } });
      expect(hqApproval).toMatchObject({ status: "EXECUTED", decidedById: p.hq2.id, decisionNote: expect.stringContaining("不用批") });
      const hqExpense = await submitExpense(p.hq2, { category: "OFFICE", amountFen: 5000, occurredOn: addDays(today, -1), description: "打印纸" }, { db: tx });
      expect(hqExpense.autoApproved).toBe(true);
      expect((await tx.expenseClaim.findUniqueOrThrow({ where: { id: hqExpense.id } })).status).toBe("APPROVED");

      const l = await submitLeave(p.staffA1, leave(5, 3), { db: tx });
      await expect(submitLeave(p.staffA1, leave(6, 1), { db: tx })).rejects.toThrow("先在请假页撤回那张");
      const e = await submitExpense(p.staffA1, { category: "OFFICE", amountFen: 5000, occurredOn: addDays(today, -1), description: "打印纸" }, { db: tx });
      expect(await cancelPendingOaFor(tx, p.staffA1.id, "调店了，审批中的单自动撤回，到新门店重新提交")).toBe(1);
      expect((await tx.leaveRequest.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("CANCELLED");
      expect((await tx.expenseClaim.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("PENDING"); // 报销不撤
      expect((await submitLeave(p.staffA1, leave(6, 1), { db: tx })).id).toBeGreaterThan(0); // 撤回以后同一天能重新交
      // 调到 B 店、再停用：报销照原来的门店（A 店）批下去，变成待付款
      await tx.user.update({ where: { id: p.staffA1.id }, data: { storeId: stores!.b.id, isActive: false } });
      const eApproval = (await tx.expenseClaim.findUniqueOrThrow({ where: { id: e.id } })).approvalRequestId!;
      expect(await approveRequest(p.mgrA, eApproval, "", tx)).toMatchObject({ executed: true });
      expect(await tx.expenseClaim.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "APPROVED", storeId: stores!.a.id });
    });
  });

  it("调店、停用时删掉明天起在老店的班，今天的留着；改今天的格子也按格记日志", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const { a, b } = stores!;
      const mk = (userId: number, storeId: number, offset: number) => tx.shiftSchedule.create({ data: { storeId, userId, date: dateFromKey(addDays(today, offset)), shift: "MORNING", updatedById: p.mgrA.id } });
      await mk(p.staffA1.id, a.id, 0);
      await mk(p.staffA1.id, a.id, 1);
      await mk(p.staffA1.id, a.id, 3);
      await mk(p.staffA1.id, b.id, 2); // 已经在新店排好的不动
      expect(await removeFutureShiftsFor(tx, p.staffA1.id, a.id, "调店了", p.mgrA.id)).toBe(2);
      const left = await tx.shiftSchedule.findMany({ where: { userId: p.staffA1.id }, orderBy: { date: "asc" }, select: { storeId: true, date: true } });
      expect(left.map((x) => [x.storeId, x.date.toISOString().slice(0, 10)])).toEqual([[a.id, today], [b.id, addDays(today, 2)]]);
      expect(await tx.auditLog.count({ where: { action: "hr.schedule.auto_clear", entityId: String(p.staffA1.id) } })).toBe(1);

      await mk(p.staffA2.id, a.id, 0);
      await mk(p.staffA2.id, a.id, 5);
      const r = await setUserActive(hq!, p.staffA2.id, false, { db: tx });
      expect(r.notice).toContain("1 格排班已删掉");
      expect(await tx.shiftSchedule.count({ where: { userId: p.staffA2.id } })).toBe(1);

      // 今天的班改成休息（可能已经算了缺勤）：按格记日志
      await saveSchedule(p.mgrA, { storeId: a.id, cells: [{ userId: p.staffA1.id, date: today, shift: "OFF" }] }, { db: tx });
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: "hr.schedule.change_past", entityId: String(p.staffA1.id) } })).detail).toMatchObject({ date: today, from: "早班", to: "休息" });
    });
  });
});
