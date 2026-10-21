import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { addDays, bjDateKey, bjDateTime, dateFromKey, weekStartOf } from "@/lib/attendance";
import type { CurrentUser } from "@/server/auth/current-user";
import { approveRequest, getApproval, rejectRequest } from "@/server/approval/approval-service";
import { addManualPunch, punch, userMonthSummary } from "@/server/hr/attendance-service";
import { cancelLeave, submitLeave } from "@/server/hr/leave-service";
import { copyLastWeek, saveSchedule } from "@/server/hr/schedule-service";

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

  it("店长的假直接总部批；总部员工的假不挂门店，只有发起人和总部看得到", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const r = await submitLeave(p.mgrA, leave(2, 1), { db: tx });
      expect(r.chain).toEqual(["HQ"]);
      const id = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).approvalRequestId!;
      await expect(approveRequest(p.mgrA, id, "", tx)).rejects.toThrow("自己");
      await expect(approveRequest(p.mgrB, id, "", tx)).rejects.toThrow();

      const r2 = await submitLeave(p.hq2, leave(2, 2), { db: tx });
      const id2 = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: r2.id } })).approvalRequestId!;
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: id2 } })).storeId).toBeNull();
      await expect(getApproval(p.regional, id2, tx)).rejects.toThrow("没有权限");
      await expect(getApproval(p.mgrA, id2, tx)).rejects.toThrow("没有权限");
      expect((await getApproval(p.hq2, id2, tx))?.can).toEqual({ decide: false, cancel: true });
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
