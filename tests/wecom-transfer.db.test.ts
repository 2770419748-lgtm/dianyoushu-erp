import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { createSimulatedWecomClient, type WecomClient } from "@/server/wecom/client";
import { cancelResignedTransfersFor, cancelTransfer, createResignedTransfers, processTransfers, transferOnJob } from "@/server/wecom/transfer-service";

// 企业微信客户继承（口径第 12 节第三步，连本机库，事务回滚不留数据）：在职转接的权限和限制、查结果回写跟进关系、
// 客户拒绝、离职继承要等删除成员、90 天 2 次。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let stores: { a: number; b: number } | null = null;

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

beforeAll(async () => {
  try {
    const list = await prisma.store.findMany({ where: { isActive: true }, orderBy: { id: "asc" }, take: 2 });
    if (list.length === 2) stores = { a: list[0]!.id, b: list[1]!.id };
  } catch {
    stores = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

const asUser = (u: { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean }) => ({ ...u, store: null, region: null }) as CurrentUser;

async function people(tx: Prisma.TransactionClient, storeA: number, storeB: number) {
  const make = (key: string, role: CurrentUser["role"], storeId: number | null) =>
    tx.user.create({ data: { username: `trtest_${key}`, passwordHash: "x", name: `继承测试${key}`, role, storeId, wecomUserid: `trTest${key}` } }).then(asUser);
  return {
    manager: await make("M", "STORE_MANAGER", storeA),
    otherManager: await make("N", "STORE_MANAGER", storeB),
    a: await make("A", "STAFF", storeA),
    b: await make("B", "STAFF", storeA),
    c: await make("C", "STAFF", storeA),
    hq: await make("H", "HQ", null),
  };
}

/** 查结果时按给定的状态码答（1 接替完毕、2 等待、3 拒绝）；isMemberDeleted 可控 */
function clientWith(status: number, deleted = true): WecomClient {
  const base = createSimulatedWecomClient();
  return {
    ...base,
    async isMemberDeleted() {
      return deleted;
    },
    async getTransferResults(input) {
      return Object.fromEntries(input.externalUserids.map((id) => [id, status]));
    },
  };
}

describe("企业微信客户继承（连本机库，事务回滚）", () => {
  it("在职转接：店长转本店的、提交后查结果，接替完毕跟进关系转到接手人名下", async (ctx) => {
    if (!stores) return ctx.skip();
    const s = stores;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx, s.a, s.b);
      const customer = await tx.customer.create({ data: { name: "继承测试客户", phone: "19922223333", wecomExternalUserid: "wmTrTest01" } });
      const follow = await tx.wecomFollow.create({ data: { externalUserid: "wmTrTest01", wecomUserid: "trTestA", userId: p.a.id, customerId: customer.id, firstAddAt: new Date() } });
      const opts = { db: tx, client: clientWith(1) };

      await expect(transferOnJob(p.a, { followId: follow.id, toUserId: p.b.id }, opts)).rejects.toThrow("只有店长和总部");
      await expect(transferOnJob(p.otherManager, { followId: follow.id, toUserId: p.b.id }, opts)).rejects.toThrow("本店员工跟进的");
      await expect(transferOnJob(p.manager, { followId: follow.id, toUserId: p.a.id }, opts)).rejects.toThrow("就是现在的跟进人");
      const done = await transferOnJob(p.manager, { followId: follow.id, toUserId: p.b.id }, opts);
      expect(done.to).toBe("继承测试B");
      await expect(transferOnJob(p.manager, { followId: follow.id, toUserId: p.c.id }, opts)).rejects.toThrow("正在转接中");

      const report = await processTransfers({ db: tx, client: clientWith(1) });
      expect(report.done).toBeGreaterThanOrEqual(1); // 演示数据里还有别的已提交的，一起推进了
      expect(await tx.wecomFollow.findUniqueOrThrow({ where: { id: follow.id } })).toMatchObject({ status: "DELETED", deletedBy: "TRANSFERRED" });
      const moved = await tx.wecomFollow.findUniqueOrThrow({ where: { externalUserid_wecomUserid: { externalUserid: "wmTrTest01", wecomUserid: "trTestB" } } });
      expect(moved).toMatchObject({ status: "ACTIVE", userId: p.b.id, customerId: customer.id });
      expect((await tx.customer.findUniqueOrThrow({ where: { id: customer.id } })).wecomExternalUserid).toBe("wmTrTest01"); // 档案绑定不变

      // 90 天内第二次可以，第三次被拦
      await transferOnJob(p.hq, { followId: moved.id, toUserId: p.c.id }, opts);
      await processTransfers({ db: tx, client: clientWith(1) });
      const third = await tx.wecomFollow.findUniqueOrThrow({ where: { externalUserid_wecomUserid: { externalUserid: "wmTrTest01", wecomUserid: "trTestC" } } });
      await expect(transferOnJob(p.hq, { followId: third.id, toUserId: p.a.id }, opts)).rejects.toThrow("90 天内已经转过 2 次");
    });
  });

  it("复查后补：企业微信不接受转接记“没成”；重新启用取消等删除的；手工取消；店长查进度只处理本店的", async (ctx) => {
    if (!stores) return ctx.skip();
    const s = stores;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx, s.a, s.b);
      const f1 = await tx.wecomFollow.create({ data: { externalUserid: "wmTrTest31", wecomUserid: "trTestA", userId: p.a.id, firstAddAt: new Date() } });
      const refuse: WecomClient = { ...createSimulatedWecomClient(), async transferCustomers(input) { return Object.fromEntries(input.externalUserids.map((id) => [id, 40096])); } };
      await expect(transferOnJob(p.manager, { followId: f1.id, toUserId: p.b.id }, { db: tx, client: refuse })).rejects.toThrow("企业微信没接受");
      expect(await tx.wecomTransfer.findFirstOrThrow({ where: { followId: f1.id } })).toMatchObject({ status: "FAILED" });
      await transferOnJob(p.manager, { followId: f1.id, toUserId: p.b.id }, { db: tx, client: clientWith(1) }); // 没成的不挡下一次

      // 离职继承：重新启用后等删除的取消
      for (const ext of ["wmTrTest32", "wmTrTest33"]) await tx.wecomFollow.create({ data: { externalUserid: ext, wecomUserid: "trTestC", userId: p.c.id, firstAddAt: new Date() } });
      await tx.user.update({ where: { id: p.c.id }, data: { isActive: false } });
      await createResignedTransfers(p.manager, { fromUserId: p.c.id, toUserId: p.b.id }, { db: tx });
      const one = await tx.wecomTransfer.findFirstOrThrow({ where: { fromUserId: p.c.id, status: "WAITING_DELETE" } });
      await expect(cancelTransfer(p.otherManager, one.id, tx)).rejects.toThrow("本店员工");
      await cancelTransfer(p.manager, one.id, tx);
      expect((await cancelResignedTransfersFor(tx, p.c.id, "员工重新启用了")).count).toBe(1);
      expect(await tx.wecomTransfer.count({ where: { fromUserId: p.c.id, status: "WAITING_DELETE" } })).toBe(0);

      // 店长查进度只处理本店员工的：别店的已提交保持不动
      const otherStaff = await tx.user.create({ data: { username: "trtest_O", passwordHash: "x", name: "继承测试O", role: "STAFF", storeId: s.b, wecomUserid: "trTestO" } });
      const otherTarget = await tx.user.create({ data: { username: "trtest_P", passwordHash: "x", name: "继承测试P", role: "STAFF", storeId: s.b, wecomUserid: "trTestP" } });
      const fo = await tx.wecomFollow.create({ data: { externalUserid: "wmTrTest34", wecomUserid: "trTestO", userId: otherStaff.id, firstAddAt: new Date() } });
      await transferOnJob(p.otherManager, { followId: fo.id, toUserId: otherTarget.id }, { db: tx, client: clientWith(1) });
      await processTransfers({ db: tx, client: clientWith(1), storeId: s.a });
      expect((await tx.wecomTransfer.findFirstOrThrow({ where: { followId: fo.id } })).status).toBe("SUBMITTED");
      expect((await tx.wecomTransfer.findFirstOrThrow({ where: { followId: f1.id, status: { not: "FAILED" } } })).status).toBe("DONE");
    });
  });

  it("客户拒绝：记拒绝，跟进关系不动；还在等的保持已提交", async (ctx) => {
    if (!stores) return ctx.skip();
    const s = stores;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx, s.a, s.b);
      const f1 = await tx.wecomFollow.create({ data: { externalUserid: "wmTrTest11", wecomUserid: "trTestA", userId: p.a.id, firstAddAt: new Date() } });
      const f2 = await tx.wecomFollow.create({ data: { externalUserid: "wmTrTest12", wecomUserid: "trTestA", userId: p.a.id, firstAddAt: new Date() } });
      await transferOnJob(p.manager, { followId: f1.id, toUserId: p.b.id }, { db: tx, client: clientWith(1) });
      await transferOnJob(p.manager, { followId: f2.id, toUserId: p.c.id }, { db: tx, client: clientWith(1) });
      await processTransfers({ db: tx, client: clientWith(2) });
      expect(await tx.wecomTransfer.count({ where: { followId: { in: [f1.id, f2.id] }, status: "SUBMITTED" } })).toBe(2); // 还在等
      await processTransfers({ db: tx, client: clientWith(3) });
      expect(await tx.wecomTransfer.count({ where: { followId: { in: [f1.id, f2.id] }, status: "REFUSED", finishedAt: { not: null } } })).toBe(2);
      expect((await tx.wecomFollow.findUniqueOrThrow({ where: { id: f1.id } })).status).toBe("ACTIVE");
    });
  });

  it("离职继承：在职的不行；停用后生成任务，企业微信后台没删人就一直等，删了才提交", async (ctx) => {
    if (!stores) return ctx.skip();
    const s = stores;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx, s.a, s.b);
      for (const ext of ["wmTrTest21", "wmTrTest22", "wmTrTest23"]) await tx.wecomFollow.create({ data: { externalUserid: ext, wecomUserid: "trTestA", userId: p.a.id, firstAddAt: new Date() } });
      await expect(createResignedTransfers(p.manager, { fromUserId: p.a.id, toUserId: p.b.id }, { db: tx })).rejects.toThrow("还在职");
      await tx.user.update({ where: { id: p.a.id }, data: { isActive: false } });
      await expect(createResignedTransfers(p.otherManager, { fromUserId: p.a.id, toUserId: p.b.id }, { db: tx })).rejects.toThrow("本店员工");
      expect((await createResignedTransfers(p.manager, { fromUserId: p.a.id, toUserId: p.b.id }, { db: tx })).count).toBe(3);
      await expect(createResignedTransfers(p.manager, { fromUserId: p.a.id, toUserId: p.c.id }, { db: tx })).rejects.toThrow("没有要交接");

      const notYet = await processTransfers({ db: tx, client: clientWith(1, false) });
      expect(notYet.waitingDelete).toBeGreaterThanOrEqual(3);
      expect(await tx.wecomTransfer.count({ where: { fromUserId: p.a.id, status: "WAITING_DELETE" } })).toBe(3);
      const submitted = await processTransfers({ db: tx, client: clientWith(1, true) });
      expect(submitted.submitted).toBeGreaterThanOrEqual(3);
      expect(await tx.wecomTransfer.count({ where: { fromUserId: p.a.id, status: "DONE" } })).toBe(3); // 同一轮里提交完接着查结果
      expect(await tx.wecomFollow.count({ where: { wecomUserid: "trTestB", status: "ACTIVE", externalUserid: { startsWith: "wmTrTest2" } } })).toBe(3);
    });
  });
});
