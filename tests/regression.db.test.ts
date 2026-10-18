import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { confirmDailyClose, reopenDailyClose } from "@/server/dailyclose/daily-close-service";
import { createPurchaseOrder, receiveGoods, submitPurchaseOrder } from "@/server/purchase/purchase-service";
import { createReturn } from "@/server/sales/return-service";
import { createSalesOrder, voidSalesOrder } from "@/server/sales/sales-service";
import { confirmStocktake, createStocktake, enterCounts } from "@/server/stocktake/stocktake-service";
import { createTransfer, receiveTransfer, shipTransfer } from "@/server/transfer/transfer-service";
import { findSessionUser } from "@/server/auth/session-user";
import { resetUserPassword, setUserActive } from "@/server/org/org-service";

// 回归测试：来自 2026-10-17 全面自检的复现脚本（每条当时都复现失败过，修好后应全部通过）。
// 这些用例会真的写库、不清理，所以只在“随时可以重建”的库上跑：
//   CI 每次用全新的库（.github/workflows/ci.yml 设了 RUN_DESTRUCTIVE_TESTS=1）；
//   本机要跑就先拷一份库副本，把 DATABASE_URL 指过去再设这个开关，别在日常用的库上跑。
// 需要 pnpm db:reset 生成的演示数据（S004～S010 的库存和历史单据）。

const enabled = process.env.RUN_DESTRUCTIVE_TESTS === "1";

const select = {
  id: true,
  username: true,
  name: true,
  role: true,
  storeId: true,
  regionId: true,
  isActive: true,
  store: { select: { id: true, name: true, regionId: true } },
  region: { select: { id: true, name: true } },
} as const;
async function userBy(username: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { username }, select })) as unknown as CurrentUser;
}
async function qtyOf(storeId: number, skuId: number) {
  return (await prisma.accessoryStock.findUnique({ where: { storeId_skuId: { storeId, skuId } } }))?.qty ?? 0;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(!enabled)("回归：全面自检复现的问题（会写库）", () => {
  it("1 盘点期间卖了配件：确认后系统数等于实盘数，不会多扣", async () => {
    const hq = await userBy("hq");
    const store = await prisma.store.findFirstOrThrow({ where: { code: "S004" } });
    const acc = await prisma.accessoryStock.findFirstOrThrow({ where: { storeId: store.id, qty: { gte: 5 } }, orderBy: { id: "asc" } });
    const st = await createStocktake(hq, { storeId: store.id });
    await createSalesOrder(hq, { storeId: store.id, items: [{ skuId: acc.skuId, qty: 2 }], paymentMethod: "CASH" });
    const shelf = await qtyOf(store.id, acc.skuId); // 柜台上真实剩下的
    const full = await prisma.stocktake.findUniqueOrThrow({ where: { id: st.id }, include: { items: { include: { device: true } } } });
    const codes = full.items.filter((i) => i.device).map((i) => i.device!.code).join("\n");
    const counts = await Promise.all(full.items.filter((i) => !i.deviceId).map(async (i) => ({ itemId: i.id, countedQty: await qtyOf(store.id, i.skuId) })));
    await enterCounts(hq, st.id, { imeiText: codes, accessoryCounts: counts });
    await confirmStocktake(hq, st.id);
    expect(await qtyOf(store.id, acc.skuId)).toBe(shelf);
  });

  it("2 盘点期间卖掉一台机器：盘点单照样能确认，卖掉的那台不算盘亏", async () => {
    const hq = await userBy("hq");
    const store = await prisma.store.findFirstOrThrow({ where: { code: "S005" } });
    const st = await createStocktake(hq, { storeId: store.id });
    const full = await prisma.stocktake.findUniqueOrThrow({ where: { id: st.id }, include: { items: { include: { device: true } } } });
    const sold = full.items.find((i) => i.device && i.device.status === "IN_STOCK")!;
    await createSalesOrder(hq, { storeId: store.id, items: [{ deviceId: sold.deviceId }], paymentMethod: "CASH" });
    const codes = full.items.filter((i) => i.device && i.id !== sold.id).map((i) => i.device!.code).join("\n");
    const counts = await Promise.all(full.items.filter((i) => !i.deviceId).map(async (i) => ({ itemId: i.id, countedQty: await qtyOf(store.id, i.skuId) })));
    await enterCounts(hq, st.id, { imeiText: codes, accessoryCounts: counts });
    await expect(confirmStocktake(hq, st.id)).resolves.toBeUndefined();
    expect((await prisma.device.findUniqueOrThrow({ where: { id: sold.deviceId! } })).status).toBe("SOLD");
  });

  it("3 只调配件的调拨单，两次同时发出、两次同时收货：都只做一次", async () => {
    const hq = await userBy("hq");
    const from = await prisma.store.findFirstOrThrow({ where: { code: "S006" } });
    const to = await prisma.store.findFirstOrThrow({ where: { code: "S007" } });
    const acc = await prisma.accessoryStock.findFirstOrThrow({ where: { storeId: from.id, qty: { gte: 6 } }, orderBy: { id: "asc" } });
    const tr = await createTransfer(hq, { fromStoreId: from.id, toStoreId: to.id, deviceIds: [], accessories: [{ skuId: acc.skuId, qty: 2 }] });
    const before = await qtyOf(from.id, acc.skuId);
    const shipped = await Promise.allSettled([shipTransfer(hq, tr!.id), shipTransfer(hq, tr!.id)]);
    expect(shipped.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(before - (await qtyOf(from.id, acc.skuId))).toBe(2);

    const item = await prisma.transferItem.findFirstOrThrow({ where: { transferId: tr!.id } });
    const toBefore = await qtyOf(to.id, acc.skuId);
    const received = await Promise.allSettled([
      receiveTransfer(hq, tr!.id, { accessoryLines: [{ itemId: item.id, qty: 2 }] }),
      receiveTransfer(hq, tr!.id, { accessoryLines: [{ itemId: item.id, qty: 2 }] }),
    ]);
    expect(received.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((await qtyOf(to.id, acc.skuId)) - toBefore).toBe(2);
    expect((await prisma.transferItem.findUniqueOrThrow({ where: { id: item.id } })).receivedQty).toBe(2);
  });

  it("4 采购配件到货，两次同时确认入库：只入一次", async () => {
    const hq = await userBy("hq");
    const store = await prisma.store.findFirstOrThrow({ where: { code: "S008" } });
    const sku = await prisma.sku.findFirstOrThrow({ where: { isActive: true, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } });
    const po = await createPurchaseOrder(hq, { storeId: store.id, items: [{ skuId: sku.id, qty: 10, unitCostFen: 100 }] });
    await submitPurchaseOrder(hq, po.id);
    const item = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { orderId: po.id } });
    const before = await qtyOf(store.id, sku.id);
    const r = await Promise.allSettled([
      receiveGoods(hq, { purchaseOrderId: po.id, lines: [{ itemId: item.id, qty: 10 }] }),
      receiveGoods(hq, { purchaseOrderId: po.id, lines: [{ itemId: item.id, qty: 10 }] }),
    ]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect((await qtyOf(store.id, sku.id)) - before).toBe(10);
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: item.id } })).receivedQty).toBe(10);
  });

  it("5 不能给未来某一天做日结确认", async () => {
    const mgr = await userBy("manager");
    const future = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
    await expect(confirmDailyClose(mgr, { storeId: mgr.storeId, bizDate: future, actuals: {} })).rejects.toThrow("还没到");
    const c = await prisma.dailyClose.findFirst({ where: { storeId: mgr.storeId!, bizDate: new Date(future) } });
    expect(c).toBeNull();
  });

  it("6 只退一个配件，不能把整单的钱退走", async () => {
    const hq = await userBy("hq");
    const store = await prisma.store.findFirstOrThrow({ where: { code: "S009" } });
    const dev = await prisma.device.findFirstOrThrow({ where: { storeId: store.id, status: "IN_STOCK" } });
    const acc = await prisma.accessoryStock.findFirstOrThrow({ where: { storeId: store.id, qty: { gte: 1 } } });
    const so = await createSalesOrder(hq, { storeId: store.id, items: [{ deviceId: dev.id }, { skuId: acc.skuId, qty: 1 }], paymentMethod: "CASH" });
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { items: true } });
    const accLine = order.items.find((i) => !i.deviceId)!;
    await expect(createReturn(hq, { salesOrderId: so.id, lines: [{ salesItemId: accLine.id, qty: 1 }], refundFen: order.totalFen, refundMethod: "CASH" })).rejects.toThrow("最多退");
    // 按这一行的成交额退，可以
    await expect(createReturn(hq, { salesOrderId: so.id, lines: [{ salesItemId: accLine.id, qty: 1 }], refundFen: accLine.lineTotalFen, refundMethod: "CASH" })).resolves.toBeTruthy();
  });

  it("7 前一天的单，作废和退货同时做：只成功一个，配件只加回一次", async () => {
    const hq = await userBy("hq");
    for (let round = 0; round < 3; round++) {
      const order = await prisma.salesOrder.findFirstOrThrow({
        where: { status: "COMPLETED", returnOrders: { none: {} }, items: { every: { deviceId: null } }, payments: { some: { method: "CASH" } }, store: { code: "S010" } },
        orderBy: { id: "desc" },
        skip: round,
        include: { items: true },
      });
      if (order.dailyCloseId) await reopenDailyClose(hq, order.storeId, order.bizDate, "回归测试").catch(() => {});
      const line = order.items[0]!;
      const before = await qtyOf(order.storeId, line.skuId);
      const r = await Promise.allSettled([
        voidSalesOrder(hq, order.id, "回归测试"),
        createReturn(hq, { salesOrderId: order.id, lines: [{ salesItemId: line.id, qty: line.qty }], refundFen: 0, refundMethod: "CASH" }),
      ]);
      expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
      expect((await qtyOf(order.storeId, line.skuId)) - before).toBe(line.qty);
    }
  });
  it("8 总部重置密码、停用账号后，这个人之前的登录立刻失效（2026-10-18 复审）", async () => {
    const hq = await userBy("hq");
    const emp = await prisma.user.findFirstOrThrow({ where: { username: "emp002" }, select: { id: true, sessionVersion: true } });
    const oldSession = { userId: emp.id, sv: emp.sessionVersion };
    expect(await findSessionUser(oldSession)).not.toBeNull();

    await resetUserPassword(hq, emp.id, "newpass123");
    expect(await findSessionUser(oldSession)).toBeNull(); // 旧 cookie 不能再用
    const afterReset = await prisma.user.findUniqueOrThrow({ where: { id: emp.id }, select: { sessionVersion: true } });
    expect(await findSessionUser({ userId: emp.id, sv: afterReset.sessionVersion })).not.toBeNull(); // 用新密码重新登录的可以

    await setUserActive(hq, emp.id, false);
    expect(await findSessionUser({ userId: emp.id, sv: afterReset.sessionVersion })).toBeNull();
    await setUserActive(hq, emp.id, true); // 重新启用后也要重新登录
    expect(await findSessionUser({ userId: emp.id, sv: afterReset.sessionVersion })).toBeNull();
  });
});

// 第三轮深审（2026-10-18）的边界用例：这几条当时就是对的，收进来防以后改坏。用 S002、S003，和上面的用例错开。
describe.skipIf(!enabled)("回归：第三轮深审的边界用例（会写库）", () => {
  async function stores() {
    const [a, b] = await Promise.all([prisma.store.findFirstOrThrow({ where: { code: "S002" } }), prisma.store.findFirstOrThrow({ where: { code: "S003" } })]);
    return { from: a.id, to: b.id };
  }

  it("9 调拨申请锁住的机器不能开单卖，发出照常", async () => {
    const hq = await userBy("hq");
    const { from, to } = await stores();
    const dev = await prisma.device.findFirstOrThrow({ where: { storeId: from, status: "IN_STOCK" }, orderBy: { id: "desc" } });
    const tr = await createTransfer(hq, { fromStoreId: from, toStoreId: to, deviceIds: [dev.id], accessories: [] });
    expect((await prisma.device.findUniqueOrThrow({ where: { id: dev.id } })).status).toBe("LOCKED");
    await expect(createSalesOrder(hq, { storeId: from, items: [{ deviceId: dev.id }], paymentMethod: "CASH" })).rejects.toThrow(/不能卖/);
    await shipTransfer(hq, tr!.id);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: dev.id } })).status).toBe("IN_TRANSIT");
  });

  it("10 配件调拨申请后被卖掉一件，再发出：库存不够就拒绝，提示作废重开，库存不动", async () => {
    const hq = await userBy("hq");
    const { from, to } = await stores();
    const acc = await prisma.accessoryStock.findFirstOrThrow({ where: { storeId: from, qty: { gte: 2, lte: 20 } }, orderBy: { id: "desc" } });
    const tr = await createTransfer(hq, { fromStoreId: from, toStoreId: to, deviceIds: [], accessories: [{ skuId: acc.skuId, qty: acc.qty }] });
    await createSalesOrder(hq, { storeId: from, items: [{ skuId: acc.skuId, qty: 1 }], paymentMethod: "CASH" });
    await expect(shipTransfer(hq, tr!.id)).rejects.toThrow(/作废/);
    expect(await qtyOf(from, acc.skuId)).toBe(acc.qty - 1);
    expect((await prisma.transferOrder.findUniqueOrThrow({ where: { id: tr!.id } })).status).toBe("REQUESTED");
  });

  it("11 作废了的销售单不能退货", async () => {
    const hq = await userBy("hq");
    const { from } = await stores();
    const dev = await prisma.device.findFirstOrThrow({ where: { storeId: from, status: "IN_STOCK" }, orderBy: { id: "asc" } });
    const so = await createSalesOrder(hq, { storeId: from, items: [{ deviceId: dev.id }], paymentMethod: "CASH" });
    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { orderId: so.id } });
    await voidSalesOrder(hq, so.id, "回归测试");
    await expect(createReturn(hq, { salesOrderId: so.id, lines: [{ salesItemId: item.id, qty: 1 }], refundFen: item.lineTotalFen, refundMethod: "CASH" })).rejects.toThrow();
    expect((await prisma.device.findUniqueOrThrow({ where: { id: dev.id } })).status).toBe("IN_STOCK");
  });

  it("12 盘点录入后有机器被调走：确认时调走的不算盘亏，没盘到的才算", async () => {
    const hq = await userBy("hq");
    const { from, to } = await stores();
    const st = await createStocktake(hq, { storeId: from });
    const items = await prisma.stocktakeItem.findMany({ where: { stocktakeId: st.id }, include: { device: { select: { id: true, code: true, status: true } } } });
    const deviceItems = items.filter((i) => i.device);
    const inStock = deviceItems.filter((i) => i.device!.status === "IN_STOCK").map((i) => i.device!);
    const [moved, missing] = inStock; // moved 盘完被调走，missing 留在店里但没盘到；其余（含良品）都盘到
    const counted = deviceItems.map((i) => i.device!).filter((d) => d.id !== moved!.id && d.id !== missing!.id);
    const accCounts = items.filter((i) => !i.deviceId).map((i) => ({ itemId: i.id, countedQty: i.expectedQty }));
    await enterCounts(hq, st.id, { imeiText: counted.map((d) => d.code).join("\n"), accessoryCounts: accCounts });
    const tr = await createTransfer(hq, { fromStoreId: from, toStoreId: to, deviceIds: [moved!.id], accessories: [] });
    await shipTransfer(hq, tr!.id);
    await confirmStocktake(hq, st.id);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: moved!.id } })).status).toBe("IN_TRANSIT");
    expect((await prisma.device.findUniqueOrThrow({ where: { id: missing!.id } })).status).toBe("LOST");
    const lossRows = await prisma.stockLedger.findMany({ where: { docNo: st.stocktakeNo, docType: "STOCKTAKE_LOSS" }, select: { deviceId: true } });
    expect(lossRows.map((r) => r.deviceId)).toEqual([missing!.id]);
  });
});
