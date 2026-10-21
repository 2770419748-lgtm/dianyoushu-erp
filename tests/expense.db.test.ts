import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { addDays, bjDateKey } from "@/lib/attendance";
import { expenseChain } from "@/lib/expense";
import type { CurrentUser } from "@/server/auth/current-user";
import { approveRequest, getApproval, rejectRequest } from "@/server/approval/approval-service";
import { cancelExpense, markExpensePaid, paidExpensesByStore, submitExpense } from "@/server/finance/expense-service";

// 费用报销（口径第 19 节，连本机库，事务回滚不留数据）：要几级批、批了待付款、总部登记付款、撤回驳回、谁能报哪家的。
// 测试用的人都在事务里新建，不碰演示数据。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type Store = { id: number; regionId: number };
let stores: { a: Store; b: Store } | null = null;
let hq: CurrentUser | null = null;
const today = bjDateKey(new Date());

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

async function people(tx: Prisma.TransactionClient) {
  const { a, b } = stores!;
  const mk = (key: string, role: CurrentUser["role"], storeId: number | null, regionId: number | null = null) =>
    tx.user.create({ data: { username: `extest_${key}`, passwordHash: "x", name: `报销测试${key}`, role, storeId, regionId } }).then(asUser);
  return {
    mgrA: await mk("mgrA", "STORE_MANAGER", a.id),
    staffA: await mk("staffA", "STAFF", a.id),
    mgrB: await mk("mgrB", "STORE_MANAGER", b.id),
    regional: await mk("regional", "REGIONAL_MANAGER", null, a.regionId),
    hq2: await mk("hq2", "HQ", null),
  };
}

const claim = (amountFen: number, extra: Record<string, unknown> = {}) => ({ category: "OFFICE", amountFen, occurredOn: addDays(today, -1), description: "买打印纸", ...extra });

describe("费用报销要几级批（纯函数）", () => {
  it("店员 2000 元以下店长批，2000 元及以上店长批完总部再批；店长、总部、区域经理直接总部批", () => {
    expect(expenseChain("STAFF", true, 199999)).toEqual(["STORE_MANAGER"]);
    expect(expenseChain("STAFF", true, 200000)).toEqual(["STORE_MANAGER", "HQ"]);
    expect(expenseChain("STORE_MANAGER", true, 100)).toEqual(["HQ"]);
    expect(expenseChain("REGIONAL_MANAGER", false, 100)).toEqual(["HQ"]);
    expect(expenseChain("HQ", false, 900000)).toEqual(["HQ"]);
  });
});

describe("费用报销（连本机库，事务回滚）", () => {
  it("店员报 186 元：店长批了待付款，总部登记付款后按付款日期算进门店费用", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const r = await submitExpense(p.staffA, claim(18600, { storeId: stores!.b.id }), { db: tx }); // 店员选别家也只算本店
      expect(r.chain).toEqual(["STORE_MANAGER"]);
      expect(r.claimNo).toMatch(/^BX\d{8}\d{4}$/);
      const row = await tx.expenseClaim.findUniqueOrThrow({ where: { id: r.id } });
      expect(row).toMatchObject({ storeId: stores!.a.id, status: "PENDING", amountFen: 18600 });
      await expect(markExpensePaid(me, r.id, { payMethod: "BANK", paidOn: today }, { db: tx })).rejects.toThrow("还没批下来");
      await expect(approveRequest(p.mgrB, row.approvalRequestId!, "", tx)).rejects.toThrow(); // 别家店长
      expect(await approveRequest(p.mgrA, row.approvalRequestId!, "", tx)).toMatchObject({ executed: true, resultNo: r.claimNo });
      expect((await tx.expenseClaim.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("APPROVED");

      await expect(markExpensePaid(p.mgrA, r.id, { payMethod: "BANK", paidOn: today }, { db: tx })).rejects.toThrow("只有总部");
      await expect(markExpensePaid(me, r.id, { payMethod: "BANK", paidOn: addDays(today, 1) }, { db: tx })).rejects.toThrow("以后的日子");
      await expect(markExpensePaid(me, r.id, { payMethod: "BANK", paidOn: addDays(today, -5) }, { db: tx })).rejects.toThrow("早于费用发生日期");
      await expect(markExpensePaid(me, r.id, { payMethod: "CHEQUE", paidOn: today }, { db: tx })).rejects.toThrow("付款方式");
      const before = (await paidExpensesByStore(tx, today.slice(0, 7))).get(stores!.a.id) ?? 0;
      await markExpensePaid(me, r.id, { payMethod: "WECHAT", paidOn: today, note: "尾号 1234" }, { db: tx });
      expect(await tx.expenseClaim.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: "PAID", payMethod: "WECHAT", paidById: me.id, payNote: "尾号 1234" });
      expect((await paidExpensesByStore(tx, today.slice(0, 7))).get(stores!.a.id)).toBe(before + 18600);
      await expect(markExpensePaid(me, r.id, { payMethod: "BANK", paidOn: today }, { db: tx })).rejects.toThrow("已经付过款");
    });
  });

  it("2000 元及以上：店长批完转总部，总部批了才待付款；在哪一级驳回都结束；撤回", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const big = await submitExpense(p.staffA, claim(268000, { category: "ENTERTAINMENT", description: "请客户经理吃饭" }), { db: tx });
      expect(big.chain).toEqual(["STORE_MANAGER", "HQ"]);
      const id = (await tx.expenseClaim.findUniqueOrThrow({ where: { id: big.id } })).approvalRequestId!;
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id } })).amountFen).toBe(268000);
      expect(await approveRequest(p.mgrA, id, "", tx)).toEqual({ executed: false, forwardedTo: "HQ" });
      expect((await tx.expenseClaim.findUniqueOrThrow({ where: { id: big.id } })).status).toBe("PENDING");
      expect(await approveRequest(me, id, "", tx)).toMatchObject({ executed: true });
      expect((await tx.expenseClaim.findUniqueOrThrow({ where: { id: big.id } })).status).toBe("APPROVED");

      const rejected = await submitExpense(p.staffA, claim(300000), { db: tx });
      const id2 = (await tx.expenseClaim.findUniqueOrThrow({ where: { id: rejected.id } })).approvalRequestId!;
      await approveRequest(p.mgrA, id2, "", tx);
      await rejectRequest(me, id2, "走总部采购", tx);
      expect((await tx.expenseClaim.findUniqueOrThrow({ where: { id: rejected.id } })).status).toBe("REJECTED");

      const cancelled = await submitExpense(p.staffA, claim(5000), { db: tx });
      await expect(cancelExpense(p.mgrA, cancelled.id, tx)).rejects.toThrow("自己");
      await cancelExpense(p.staffA, cancelled.id, tx);
      expect((await tx.expenseClaim.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe("CANCELLED");
      await expect(cancelExpense(p.staffA, cancelled.id, tx)).rejects.toThrow("不能撤回");
    });
  });

  it("店长自己的直接总部批、不能批自己的；总部的人可以算某家店或者不挂门店；区域经理只能选辖区的店", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      const own = await submitExpense(p.mgrA, claim(9800, { category: "TRANSPORT" }), { db: tx });
      expect(own.chain).toEqual(["HQ"]);
      const ownApproval = (await tx.expenseClaim.findUniqueOrThrow({ where: { id: own.id } })).approvalRequestId!;
      await expect(approveRequest(p.mgrA, ownApproval, "", tx)).rejects.toThrow("自己");

      const hqClaim = await submitExpense(p.hq2, claim(50000), { db: tx });
      const hqRow = await tx.expenseClaim.findUniqueOrThrow({ where: { id: hqClaim.id } });
      expect(hqRow.storeId).toBeNull();
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: hqRow.approvalRequestId! } })).storeId).toBeNull();
      await expect(getApproval(p.mgrA, hqRow.approvalRequestId!, tx)).rejects.toThrow("没有权限");
      expect(await approveRequest(me, hqRow.approvalRequestId!, "", tx)).toMatchObject({ executed: true });

      const forStore = await submitExpense(p.hq2, claim(50000, { storeId: stores!.b.id }), { db: tx });
      expect((await tx.expenseClaim.findUniqueOrThrow({ where: { id: forStore.id } })).storeId).toBe(stores!.b.id);
      await expect(submitExpense(p.regional, claim(50000, { storeId: stores!.b.id }), { db: tx })).rejects.toThrow("范围内");
      expect((await submitExpense(p.regional, claim(50000, { storeId: stores!.a.id }), { db: tx })).chain).toEqual(["HQ"]);
    });
  });

  it("填写校验：类型、金额、日期、说明", async (ctx) => {
    if (!stores || !hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const p = await people(tx);
      await expect(submitExpense(p.staffA, claim(100, { category: "FOOD" }), { db: tx })).rejects.toThrow("费用类型");
      await expect(submitExpense(p.staffA, claim(0), { db: tx })).rejects.toThrow("大于 0");
      await expect(submitExpense(p.staffA, claim(10.5), { db: tx })).rejects.toThrow("大于 0");
      await expect(submitExpense(p.staffA, claim(5000001), { db: tx })).rejects.toThrow("最多报");
      await expect(submitExpense(p.staffA, claim(100, { occurredOn: addDays(today, 1) }), { db: tx })).rejects.toThrow("以后的日子");
      await expect(submitExpense(p.staffA, claim(100, { occurredOn: addDays(today, -91) }), { db: tx })).rejects.toThrow("90 天以内");
      await expect(submitExpense(p.staffA, claim(100, { description: "  " }), { db: tx })).rejects.toThrow("写一下");
    });
  });
});
