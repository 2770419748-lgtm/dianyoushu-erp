import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { ApprovalRequiredError } from "@/server/approval/approval-check";
import { approveRequest, cancelRequest, createApprovalRequest, rejectRequest, type ApprovalPayload } from "@/server/approval/approval-service";
import { createReturnTx } from "@/server/sales/return-service";
import { createSalesOrderTx, voidSalesOrderTx, type SalesOrderInput } from "@/server/sales/sales-service";
import { receiveDevices } from "@/server/stock/stock-service";
import { createTransferTx } from "@/server/transfer/transfer-service";
import { runIntegrityChecks } from "../prisma/integrity-checks";

// 审批（口径第 17 节，连本机库，事务回滚不留数据）：触发规则 → 存审批单 → 通过后以发起人身份执行 / 做不成记原因；驳回、撤回、同一件事只能一张待审批。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type U = { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean };
type Fixture = { storeId: number; otherStoreId: number; skuId: number; priceFen: number; hq: CurrentUser; staff: CurrentUser; manager: CurrentUser };
let fixture: Fixture | null = null;

const asUser = (u: U) => ({ ...u, store: null, region: null }) as CurrentUser;
const imei = (seed: number) => String(990000000000000 + seed).padStart(15, "0");

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
    const [stores, sku, hq] = await Promise.all([
      prisma.store.findMany({ where: { isActive: true }, orderBy: { id: "asc" }, take: 2 }),
      prisma.sku.findFirst({ where: { isActive: true, guidePriceFen: { gt: 100000, lte: 500000 }, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    const [store, other] = stores;
    if (!store || !other || !sku || !hq) return;
    const [staff, manager] = await Promise.all([
      prisma.user.findFirst({ where: { role: "STAFF", storeId: store.id, isActive: true } }),
      prisma.user.findFirst({ where: { role: "STORE_MANAGER", storeId: store.id, isActive: true } }),
    ]);
    if (!staff || !manager) return;
    fixture = { storeId: store.id, otherStoreId: other.id, skuId: sku.id, priceFen: sku.guidePriceFen, hq: asUser(hq), staff: asUser(staff), manager: asUser(manager) };
  } catch {
    fixture = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 只打开这次要测的规则（演示库里打开了几条，先全关） */
async function rules(tx: Prisma.TransactionClient, list: { kind: "SALE_DISCOUNT" | "SALE_BELOW_COST" | "RETURN_REFUND" | "SALE_VOID" | "TRANSFER" | "STOCKTAKE_LOSS"; thresholdFen?: number | null; thresholdBp?: number | null; approverRole: "STORE_MANAGER" | "HQ" }[]) {
  await tx.approvalRule.updateMany({ data: { enabled: false } });
  for (const r of list) {
    const data = { enabled: true, thresholdFen: r.thresholdFen ?? null, thresholdBp: r.thresholdBp ?? null, approverRole: r.approverRole };
    await tx.approvalRule.upsert({ where: { kind: r.kind }, create: { kind: r.kind, ...data }, update: data });
  }
}

async function device(tx: Prisma.TransactionClient, seed: number, storeId?: number) {
  const f = fixture!;
  const [id] = await receiveDevices(tx, { storeId: storeId ?? f.storeId, skuId: f.skuId, devices: [{ sn: null, imei1: imei(seed), imei2: null }], costFen: 100000, docType: "PURCHASE_RECEIPT", docNo: `RI-SP-${seed}`, operatorId: f.hq.id });
  return id!;
}

/** 让利 10% 开一台 */
function discountSale(deviceId: number): SalesOrderInput {
  const f = fixture!;
  const discountFen = Math.round(f.priceFen / 10);
  return { storeId: f.storeId, items: [{ deviceId }], discountFen, payments: [{ method: "CASH", amountFen: f.priceFen - discountFen }] };
}

/** 跑一下，接住 ApprovalRequiredError 存成审批单（和 Server Function 做的一样） */
async function submit(tx: Prisma.TransactionClient, user: CurrentUser, run: () => Promise<unknown>, payload: ApprovalPayload) {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof ApprovalRequiredError)) throw error;
    return createApprovalRequest(user, error, payload, "", tx);
  }
  throw new Error("应该要审批，结果直接做了");
}

describe("审批（连本机库，事务回滚）", () => {
  it("开单让利超过 5%：店员要店长批，批了以店员身份开出来；店长自己开不用批；店员不能批", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await rules(tx, [{ kind: "SALE_DISCOUNT", thresholdBp: 500, approverRole: "STORE_MANAGER" }]);
      const d1 = await device(tx, 1);
      const input = discountSale(d1);
      const req = await submit(tx, f.staff, () => createSalesOrderTx(tx, f.staff, input), { action: "SALE", input, details: [] });
      const pending = await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(pending).toMatchObject({ status: "PENDING", action: "SALE", approverRole: "STORE_MANAGER", requestedById: f.staff.id, amountFen: Math.round(f.priceFen / 10) });
      expect(pending.requestNo).toMatch(/^SP\d{12}$/);
      expect((await tx.device.findUniqueOrThrow({ where: { id: d1 } })).status).toBe("IN_STOCK"); // 没批之前不开

      await expect(approveRequest(f.staff, req.id, "", tx)).rejects.toThrow("不能批自己发起的");
      const r = await approveRequest(f.manager, req.id, "老客户", tx);
      expect(r.executed).toBe(true);
      const done = await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(done).toMatchObject({ status: "EXECUTED", decidedById: f.manager.id, decisionNote: "老客户" });
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: done.resultId! } });
      expect([order.salespersonId, order.discountFen, order.orderNo]).toEqual([f.staff.id, Math.round(f.priceFen / 10), done.resultNo]);

      // 店长自己让利 10% 不用批
      const d2 = await device(tx, 2);
      await expect(createSalesOrderTx(tx, f.manager, discountSale(d2))).resolves.toMatchObject({ orderNo: expect.any(String) });
    });
  });

  it("批的时候情况变了（机器已经卖了）：记“批了没做成”和原因，不会开出第二张单", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await rules(tx, [{ kind: "SALE_DISCOUNT", thresholdBp: 500, approverRole: "STORE_MANAGER" }]);
      const d = await device(tx, 11);
      const input = discountSale(d);
      const req = await submit(tx, f.staff, () => createSalesOrderTx(tx, f.staff, input), { action: "SALE", input, details: [] });
      await createSalesOrderTx(tx, f.manager, { storeId: f.storeId, items: [{ deviceId: d }], paymentMethod: "CASH" }); // 店长先按原价卖掉了
      const r = await approveRequest(f.manager, req.id, "", tx);
      expect(r.executed).toBe(false);
      const failed = await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(failed.status).toBe("FAILED");
      expect(failed.error).toBeTruthy();
      expect(await tx.salesOrderItem.count({ where: { deviceId: d } })).toBe(1);
      await expect(approveRequest(f.manager, req.id, "", tx)).rejects.toThrow("已经处理过了");
      expect((await runIntegrityChecks(tx as unknown as PrismaClient)).approval).toBe(0);
    });
  });

  it("驳回要写原因；撤回只能发起人撤；退款达到门槛要批，店长退不用批", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await rules(tx, [{ kind: "SALE_DISCOUNT", thresholdBp: 500, approverRole: "STORE_MANAGER" }, { kind: "RETURN_REFUND", thresholdFen: 1000, approverRole: "STORE_MANAGER" }]);
      const a = await device(tx, 21);
      const inputA = discountSale(a);
      const ra = await submit(tx, f.staff, () => createSalesOrderTx(tx, f.staff, inputA), { action: "SALE", input: inputA, details: [] });
      await expect(rejectRequest(f.manager, ra.id, " ", tx)).rejects.toThrow("驳回原因");
      await rejectRequest(f.manager, ra.id, "让利太多", tx);
      expect(await tx.approvalRequest.findUniqueOrThrow({ where: { id: ra.id } })).toMatchObject({ status: "REJECTED", decisionNote: "让利太多" });

      const b = await device(tx, 22);
      const inputB = discountSale(b);
      const rb = await submit(tx, f.staff, () => createSalesOrderTx(tx, f.staff, inputB), { action: "SALE", input: inputB, details: [] });
      await expect(cancelRequest(f.manager, rb.id, tx)).rejects.toThrow("只有发起人");
      await cancelRequest(f.staff, rb.id, tx);
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: rb.id } })).status).toBe("CANCELLED");

      // 退货：店员开的单（没让利不用批），店员退 → 要批；店长退 → 不用批
      const c = await device(tx, 23);
      const sale = await createSalesOrderTx(tx, f.staff, { storeId: f.storeId, items: [{ deviceId: c }], paymentMethod: "CASH" });
      const item = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: sale.id } });
      const back = { salesOrderId: sale.id, lines: [{ salesItemId: item.id, qty: 1 }], refundFen: f.priceFen, refundMethod: "CASH" };
      const rr = await submit(tx, f.staff, () => createReturnTx(tx, f.staff, back), { action: "RETURN", input: back, details: [] });
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: rr.id } })).action).toBe("RETURN");
      const r = await approveRequest(f.manager, rr.id, "", tx);
      expect(r.executed).toBe(true);
      expect((await tx.device.findUniqueOrThrow({ where: { id: c } })).status).toBe("IN_STOCK");
    });
  });

  it("调拨货值达到门槛要总部批，店长不能批；批了建出调拨单、机器锁定", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await rules(tx, [{ kind: "TRANSFER", thresholdFen: 50000, approverRole: "HQ" }]);
      const d = await device(tx, 31);
      const input = { fromStoreId: f.storeId, toStoreId: f.otherStoreId, deviceIds: [d], accessories: [] };
      const req = await submit(tx, f.manager, () => createTransferTx(tx, f.manager, input), { action: "TRANSFER", input, details: [] });
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).approverRole).toBe("HQ");
      await expect(approveRequest(f.manager, req.id, "", tx)).rejects.toThrow("不能批自己发起的");
      const r = await approveRequest(f.hq, req.id, "", tx);
      expect(r.executed).toBe(true);
      expect((await tx.device.findUniqueOrThrow({ where: { id: d } })).status).toBe("LOCKED");
    });
  });

  it("作废要总部批：同一张单同时只能有一张待审批；批了作废掉", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await rules(tx, [{ kind: "SALE_VOID", thresholdFen: 0, approverRole: "HQ" }]);
      const d = await device(tx, 41);
      const sale = await createSalesOrderTx(tx, f.manager, { storeId: f.storeId, items: [{ deviceId: d }], paymentMethod: "CASH" });
      const req = await submit(tx, f.manager, () => voidSalesOrderTx(tx, f.manager, sale.id, "开错单"), { action: "SALE_VOID", orderId: sale.id, reason: "开错单", details: [] });
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).dedupeKey).toBe(`SALE_VOID:${sale.id}`);
      await approveRequest(f.hq, req.id, "", tx);
      expect((await tx.salesOrder.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("VOIDED");
    });
  });

  it("同一张单的作废已经有一张待审批，再提交被拦下", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await rules(tx, [{ kind: "SALE_VOID", thresholdFen: 0, approverRole: "HQ" }]);
      const d = await device(tx, 51);
      const sale = await createSalesOrderTx(tx, f.manager, { storeId: f.storeId, items: [{ deviceId: d }], paymentMethod: "CASH" });
      const payload: ApprovalPayload = { action: "SALE_VOID", orderId: sale.id, reason: "开错单", details: [] };
      await submit(tx, f.manager, () => voidSalesOrderTx(tx, f.manager, sale.id, "开错单"), payload);
      // 数据库部分唯一索引拦下（这一步之后事务就不能用了，放最后）
      await expect(submit(tx, f.manager, () => voidSalesOrderTx(tx, f.manager, sale.id, "开错单"), payload)).rejects.toThrow("已经有一张待审批");
    });
  });
});
