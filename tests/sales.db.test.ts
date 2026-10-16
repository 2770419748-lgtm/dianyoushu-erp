import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { createSalesOrderTx, SalesError, voidSalesOrderTx } from "@/server/sales/sales-service";
import { changeAccessoryStock, receiveDevices } from "@/server/stock/stock-service";

// 开单核心链路（连本机库，事务回滚不留数据）：
// 开一单一机一配件 → 机器已售、配件 −1、流水两条、收款等于应收；作废 → 机器回在库、配件加回、流水再两条。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let dbReady = false;
let fixture: { storeId: number; deviceSkuId: number; accessorySkuId: number; user: CurrentUser } | null = null;

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 20000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

function fakeDevices(count: number, seed: number) {
  return Array.from({ length: count }, (_, i) => ({ sn: null, imei1: String(920000000000000 + seed * 1000 + i).padStart(15, "0"), imei2: null }));
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [store, deviceSku, accessorySku, hq] = await Promise.all([
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" }, include: { store: true, region: true } }),
    ]);
    if (store && deviceSku && accessorySku && hq) {
      fixture = {
        storeId: store.id,
        deviceSkuId: deviceSku.id,
        accessorySkuId: accessorySku.id,
        user: {
          id: hq.id,
          username: hq.username,
          name: hq.name,
          role: hq.role,
          storeId: hq.storeId,
          regionId: hq.regionId,
          isActive: hq.isActive,
          store: null,
          region: null,
        },
      };
      dbReady = true;
    }
  } catch {
    dbReady = false;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("开单与作废（连本机库，事务回滚）", () => {
  it("开一单一机一配件：扣库存、写流水、收款等于应收；作废后恢复", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      // 准备库存：1 台机器、5 件配件
      const [deviceId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: fakeDevices(1, 1), costFen: 400000, docType: "PURCHASE_RECEIPT", docNo: "RI-S-1", operatorId: f.user.id });
      await changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: 5, docType: "PURCHASE_RECEIPT", docNo: "RI-S-1", operatorId: f.user.id });
      const accessoryBefore = (await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: f.storeId, skuId: f.accessorySkuId } } }))!.qty;

      // 开单：机器按 4999 元，配件 1 件按 29 元，整单优惠 28 元 → 应收 5000 元
      const { id, orderNo } = await createSalesOrderTx(tx, f.user, {
        storeId: f.storeId,
        items: [
          { deviceId, unitPriceFen: 499900 },
          { skuId: f.accessorySkuId, qty: 1, unitPriceFen: 2900 },
        ],
        discountFen: 2800,
        paymentMethod: "WECHAT",
      });

      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { items: true, payments: true } });
      expect(order.subtotalFen).toBe(502800);
      expect(order.totalFen).toBe(500000);
      expect(order.payments).toHaveLength(1);
      expect(order.payments[0]!.amountFen).toBe(500000);
      expect(order.items.find((i) => i.deviceId)!.costFen).toBe(400000);

      const device = await tx.device.findUniqueOrThrow({ where: { id: deviceId! } });
      expect(device.status).toBe("SOLD");
      const accessoryAfter = (await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: f.storeId, skuId: f.accessorySkuId } } }))!.qty;
      expect(accessoryBefore - accessoryAfter).toBe(1);
      const saleLedgers = await tx.stockLedger.findMany({ where: { docNo: orderNo, docType: "SALE" } });
      expect(saleLedgers).toHaveLength(2);
      expect(saleLedgers.map((l) => l.qtyDelta)).toEqual([-1, -1]);

      // 已售的机器不能再开一单
      await expect(createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ deviceId }], paymentMethod: "CASH" })).rejects.toThrow(SalesError);

      // 作废：恢复库存，再写两条流水
      await voidSalesOrderTx(tx, f.user, id, "客户不要了");
      const voided = await tx.salesOrder.findUniqueOrThrow({ where: { id } });
      expect(voided.status).toBe("VOIDED");
      expect(voided.voidReason).toBe("客户不要了");
      expect((await tx.device.findUniqueOrThrow({ where: { id: deviceId! } })).status).toBe("IN_STOCK");
      expect((await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: f.storeId, skuId: f.accessorySkuId } } }))!.qty).toBe(accessoryBefore);
      const voidLedgers = await tx.stockLedger.findMany({ where: { docNo: orderNo, docType: "SALE_VOID" } });
      expect(voidLedgers.map((l) => l.qtyDelta)).toEqual([1, 1]);
      // 作废过的不能再作废
      await expect(voidSalesOrderTx(tx, f.user, id, "")).rejects.toThrow(SalesError);
    });
  });

  it("优惠不能超过商品合计；配件库存不够拒绝", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-S-2", operatorId: f.user.id });
      const stock = (await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: f.storeId, skuId: f.accessorySkuId } } }))!.qty;
      await expect(
        createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ skuId: f.accessorySkuId, qty: 1, unitPriceFen: 1000 }], discountFen: 2000, paymentMethod: "CASH" }),
      ).rejects.toThrow(SalesError);
      await expect(
        createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ skuId: f.accessorySkuId, qty: stock + 1, unitPriceFen: 1000 }], paymentMethod: "CASH" }),
      ).rejects.toThrow(SalesError);
    });
  });
});
