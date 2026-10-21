import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { listEmployees, saveEmployeeProfile } from "@/server/hr/employee-service";
import { getNotice, pruneNoticeNotifications, publishNotice, withdrawNotice } from "@/server/notice/notice-service";
import { setUserActive } from "@/server/org/org-service";

// 人事 OA 第一步（口径第 19 节，连本机库，事务回滚不留数据）：公告的范围、消息、已读、撤下；员工档案的范围、工资谁能看、校验。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let f: { hq: CurrentUser; manager: CurrentUser; staff: CurrentUser; otherStaff: CurrentUser; regional: CurrentUser } | null = null;

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

const asUser = async (where: Prisma.UserWhereInput) => {
  const u = await prisma.user.findFirst({ where: { ...where, isActive: true }, orderBy: { id: "asc" }, include: { store: { select: { id: true, name: true, regionId: true } }, region: { select: { id: true, name: true } } } });
  return u ? ({ ...u } as unknown as CurrentUser) : null;
};

beforeAll(async () => {
  try {
    const stores = await prisma.store.findMany({ where: { isActive: true }, orderBy: { id: "asc" }, take: 2 });
    if (stores.length < 2) return;
    const [hq, manager, staff, otherStaff, regional] = await Promise.all([
      asUser({ role: "HQ" }),
      asUser({ role: "STORE_MANAGER", storeId: stores[0]!.id }),
      asUser({ role: "STAFF", storeId: stores[0]!.id }),
      asUser({ role: "STAFF", store: { regionId: { not: stores[0]!.regionId } } }),
      asUser({ role: "REGIONAL_MANAGER", regionId: stores[0]!.regionId }),
    ]);
    if (hq && manager && staff && otherStaff && regional) f = { hq, manager, staff, otherStaff, regional };
  } catch {
    f = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("公告和员工档案（连本机库，事务回滚）", () => {
  it("店长只能发本店：本店的人收到消息、别店的看不到；打开算已读；撤下后消息也没了", async (ctx) => {
    if (!f) return ctx.skip();
    const p = f;
    await inRolledBackTx(async (tx) => {
      await expect(publishNotice(p.staff, { title: "x", body: "y" }, tx)).rejects.toThrow("总部和店长");
      await expect(publishNotice(p.manager, { title: "", body: "y" }, tx)).rejects.toThrow("标题");
      const r = await publishNotice(p.manager, { title: "周六盘点", body: "8:30 到店", scope: "ALL" }, tx); // 店长选了全部也只发本店
      const notice = await tx.notice.findUniqueOrThrow({ where: { id: r.id } });
      expect(notice).toMatchObject({ scope: "STORE", storeId: p.manager.storeId });
      const storeUsers = await tx.user.count({ where: { storeId: p.manager.storeId, isActive: true } });
      expect(r.recipients).toBe(storeUsers - 1); // 发给的人不算发布人自己
      expect(await tx.notification.count({ where: { noticeId: r.id } })).toBe(storeUsers - 1);

      expect(await getNotice(p.otherStaff, r.id, tx)).toBeNull(); // 别店的看不到
      const seen = await getNotice(p.staff, r.id, tx);
      expect(seen?.reads).toBeNull(); // 店员看不到已读统计
      expect(await tx.notification.findFirstOrThrow({ where: { noticeId: r.id, userId: p.staff.id } })).toMatchObject({ readAt: expect.any(Date) });
      await getNotice(p.staff, r.id, tx); // 同一个人再打开（两个标签页）：已有的跳过，不报错
      await getNotice(p.hq, r.id, tx); // 总部不在本店公告的发送范围里，打开不算已读
      expect(await tx.noticeRead.count({ where: { noticeId: r.id } })).toBe(1);
      const mine = await getNotice(p.manager, r.id, tx);
      expect(mine?.reads).toMatchObject({ readCount: 1, recipients: storeUsers - 1 });
      expect(mine!.reads!.unread).toHaveLength(storeUsers - 2);

      await expect(withdrawNotice(p.staff, r.id, tx)).rejects.toThrow("发布人和总部");
      await withdrawNotice(p.manager, r.id, tx);
      expect(await tx.notification.count({ where: { noticeId: r.id } })).toBe(0);
      expect(await getNotice(p.staff, r.id, tx)).toBeNull();
    });
  });

  it("总部发区域公告：区域经理和区域里各店的人收到", async (ctx) => {
    if (!f) return ctx.skip();
    const p = f;
    await inRolledBackTx(async (tx) => {
      const regionId = p.regional.regionId!;
      const r = await publishNotice(p.hq, { title: "区域冲刺", body: "最后十天", scope: "REGION", regionId }, tx);
      const expected = await tx.user.count({ where: { isActive: true, OR: [{ regionId }, { store: { regionId } }] } });
      expect(r.recipients).toBe(expected);
      expect(await getNotice(p.regional, r.id, tx)).not.toBeNull();
      expect(await getNotice(p.otherStaff, r.id, tx)).toBeNull();
      await expect(publishNotice(p.hq, { title: "x", body: "y", scope: "STORE", storeId: 999999 }, tx)).rejects.toThrow("选一家在营业的门店");
      await expect(publishNotice(p.hq, { title: "x", body: "y", scope: "EVERYONE" }, tx)).rejects.toThrow("发给谁不对"); // 不认识的范围不当成全公司
      const closed = await tx.store.create({ data: { code: "ZT-NT1", name: "停业测试店", regionId, isActive: false } });
      await expect(publishNotice(p.hq, { title: "x", body: "y", scope: "STORE", storeId: closed.id }, tx)).rejects.toThrow("在营业的门店");
    });
  });

  it("调店以后：小铃铛里原门店的公告消息清掉，全公司的留着", async (ctx) => {
    if (!f) return ctx.skip();
    const p = f;
    await inRolledBackTx(async (tx) => {
      const storeNotice = await publishNotice(p.manager, { title: "本店通知", body: "只给本店" }, tx);
      const allNotice = await publishNotice(p.hq, { title: "全公司通知", body: "大家都看" }, tx);
      expect(await tx.notification.count({ where: { userId: p.staff.id, noticeId: { in: [storeNotice.id, allNotice.id] } } })).toBe(2);
      await tx.user.update({ where: { id: p.staff.id }, data: { storeId: p.otherStaff.storeId } });
      expect(await pruneNoticeNotifications(tx, p.staff.id)).toBeGreaterThanOrEqual(1);
      expect(await tx.notification.findMany({ where: { userId: p.staff.id, noticeId: { in: [storeNotice.id, allNotice.id] } }, select: { noticeId: true } })).toEqual([{ noticeId: allNotice.id }]);
    });
  });

  it("员工档案：店长看本店、看不到工资；总部能看能改，电话和日期要对", async (ctx) => {
    if (!f) return ctx.skip();
    const p = f;
    const mine = await listEmployees(p.manager, {});
    expect(mine.showSalary).toBe(false);
    expect(mine.rows.every((r) => r.baseSalaryFen === null && r.phone === null)).toBe(true);
    expect(mine.rows.every((r) => r.store?.includes(p.manager.store!.name))).toBe(true);
    const all = await listEmployees(p.hq, {});
    expect(all.showSalary).toBe(true);
    await expect(listEmployees(p.staff, {})).rejects.toThrow();
    await inRolledBackTx(async (tx) => {
      await expect(saveEmployeeProfile(p.manager, p.staff.id, { position: "收银" }, tx)).rejects.toThrow("只有总部");
      await expect(saveEmployeeProfile(p.hq, p.staff.id, { phone: "123" }, tx)).rejects.toThrow("11 位");
      await expect(saveEmployeeProfile(p.hq, p.staff.id, { hireDate: "2026-02-30" }, tx)).rejects.toThrow("不是真实的日期");
      await expect(saveEmployeeProfile(p.hq, p.staff.id, { hireDate: "2026-05-01", leaveDate: "2026-04-01" }, tx)).rejects.toThrow("不能早于");
      await saveEmployeeProfile(p.hq, p.staff.id, { position: "收银", phone: "13800001111", baseSalaryFen: 420000, hireDate: "2025-03-01" }, tx);
      expect(await tx.employeeProfile.findUniqueOrThrow({ where: { userId: p.staff.id } })).toMatchObject({ position: "收银", phone: "13800001111", baseSalaryFen: 420000 });
    });
  });

  it("停用记离职日期（总部填过的不覆盖、入职还没到的不记），重新启用只清自动记的，原值进日志", async (ctx) => {
    if (!f) return ctx.skip();
    const p = f;
    await inRolledBackTx(async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const mk = (key: string) => tx.user.create({ data: { username: `lvtest_${key}`, passwordHash: "x", name: `离职测试${key}`, role: "STAFF", storeId: p.staff.storeId } });
      const a = await mk("a");
      await setUserActive(p.hq, a.id, false, { db: tx });
      const auto = (await tx.employeeProfile.findUniqueOrThrow({ where: { userId: a.id } })).leaveDate!.toISOString().slice(0, 10);
      expect([today, bj]).toContain(auto); // 北京时间的今天
      await setUserActive(p.hq, a.id, true, { db: tx });
      expect((await tx.employeeProfile.findUniqueOrThrow({ where: { userId: a.id } })).leaveDate).toBeNull();
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: "user.activate", entityId: String(a.id) }, orderBy: { id: "desc" } })).detail).toMatchObject({ leaveDateBefore: auto, leaveDateAfter: null });

      const b = await mk("b"); // 总部填了月底走
      await tx.employeeProfile.create({ data: { userId: b.id, leaveDate: new Date("2026-10-31T00:00:00Z") } });
      await setUserActive(p.hq, b.id, false, { db: tx });
      await setUserActive(p.hq, b.id, true, { db: tx });
      expect((await tx.employeeProfile.findUniqueOrThrow({ where: { userId: b.id } })).leaveDate?.toISOString().slice(0, 10)).toBe("2026-10-31");

      const c = await mk("c"); // 入职日期还没到
      await tx.employeeProfile.create({ data: { userId: c.id, hireDate: new Date(Date.now() + 30 * 24 * 3600 * 1000) } });
      await setUserActive(p.hq, c.id, false, { db: tx });
      expect((await tx.employeeProfile.findUniqueOrThrow({ where: { userId: c.id } })).leaveDate).toBeNull();
    });
  });
});
