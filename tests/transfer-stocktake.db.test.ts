import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { applyDeviceAction, changeAccessoryStock, receiveDevices } from "@/server/stock/stock-service";

// 调拨与盘点的核心链路（走 stock-service，事务回滚不留数据）：
// 调拨：在库 → 锁定 → 在途（发出店 −1）→ 在库（收货店 +1，归属改收货店）；在途不能卖。
// 盘点：盘亏机器变"盘亏"并写 −1 流水；配件盘盈盘亏写流水且余额一致。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let dbReady = false;
let fixture: { fromStoreId: number; toStoreId: number; deviceSkuId: number; accessorySkuId: number; userId: number } | null = null;

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

function fakeImeis(count: number, seed: number): string[] {
  return Array.from({ length: count }, (_, i) => String(910000000000000 + seed * 1000 + i).padStart(15, "0"));
}

function fakeDevices(count: number, seed: number) {
  return fakeImeis(count, seed).map((imei1) => ({ sn: null, imei1, imei2: null }));
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [stores, deviceSku, accessorySku, user] = await Promise.all([
      prisma.store.findMany({ where: { isActive: true }, orderBy: { id: "asc" }, take: 2 }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    if (stores.length === 2 && deviceSku && accessorySku && user) {
      fixture = { fromStoreId: stores[0]!.id, toStoreId: stores[1]!.id, deviceSkuId: deviceSku.id, accessorySkuId: accessorySku.id, userId: user.id };
      dbReady = true;
    }
  } catch {
    dbReady = false;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("调拨链路（连本机库，事务回滚）", () => {
  it("锁定 → 发出 → 收货：状态和归属正确，发出店 −1、收货店 +1；在途不能卖", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const [id] = await receiveDevices(tx, { storeId: f.fromStoreId, skuId: f.deviceSkuId, devices: fakeDevices(1, 1), costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-T-1", operatorId: f.userId });
      const base = { deviceId: id!, operatorId: f.userId, docNo: "TR-T-1" };

      const locked = await applyDeviceAction(tx, { ...base, action: "LOCK_FOR_TRANSFER", docType: "TRANSFER_LOCK" });
      expect(locked.status).toBe("LOCKED");
      await expect(applyDeviceAction(tx, { ...base, action: "SELL", docType: "SALE", docNo: "SO-T-1" })).rejects.toThrow();

      const shipped = await applyDeviceAction(tx, { ...base, action: "SHIP", docType: "TRANSFER_OUT" });
      expect(shipped.status).toBe("IN_TRANSIT");
      expect(shipped.storeId).toBe(f.fromStoreId);
      await expect(applyDeviceAction(tx, { ...base, action: "SELL", docType: "SALE", docNo: "SO-T-2" })).rejects.toThrow();

      const received = await applyDeviceAction(tx, { ...base, action: "TRANSFER_RECEIVE", docType: "TRANSFER_IN", newStoreId: f.toStoreId });
      expect(received.status).toBe("IN_STOCK");
      expect(received.storeId).toBe(f.toStoreId);

      const ledgers = await tx.stockLedger.findMany({ where: { docNo: "TR-T-1" }, orderBy: { id: "asc" } });
      expect(ledgers.map((l) => [l.docType, l.qtyDelta, l.storeId])).toEqual([
        ["TRANSFER_LOCK", 0, f.fromStoreId],
        ["TRANSFER_OUT", -1, f.fromStoreId],
        ["TRANSFER_IN", 1, f.toStoreId],
      ]);
      // 流水净变化：发出店 −1，收货店 +1
      const sum = (storeId: number) => ledgers.filter((l) => l.storeId === storeId).reduce((s, l) => s + l.qtyDelta, 0);
      expect(sum(f.fromStoreId)).toBe(-1);
      expect(sum(f.toStoreId)).toBe(1);
    });
  });

  it("申请后作废：解锁回在库，数量不变", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const [id] = await receiveDevices(tx, { storeId: f.fromStoreId, skuId: f.deviceSkuId, devices: fakeDevices(1, 2), costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-T-2", operatorId: f.userId });
      await applyDeviceAction(tx, { deviceId: id!, action: "LOCK_FOR_TRANSFER", docType: "TRANSFER_LOCK", docNo: "TR-T-2", operatorId: f.userId });
      const unlocked = await applyDeviceAction(tx, { deviceId: id!, action: "UNLOCK", docType: "TRANSFER_UNLOCK", docNo: "TR-T-2", operatorId: f.userId });
      expect(unlocked.status).toBe("IN_STOCK");
      const ledgers = await tx.stockLedger.findMany({ where: { docNo: "TR-T-2" } });
      expect(ledgers.every((l) => l.qtyDelta === 0)).toBe(true);
    });
  });
});

describe("盘点差异（连本机库，事务回滚）", () => {
  it("盘亏一台：机器变盘亏，流水 −1，在库数少 1", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const ids = await receiveDevices(tx, { storeId: f.fromStoreId, skuId: f.deviceSkuId, devices: fakeDevices(2, 3), costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-T-3", operatorId: f.userId });
      const before = await tx.device.count({ where: { storeId: f.fromStoreId, status: "IN_STOCK" } });
      const lost = await applyDeviceAction(tx, { deviceId: ids[1]!, action: "STOCKTAKE_LOSS", docType: "STOCKTAKE_LOSS", docNo: "ST-T-1", operatorId: f.userId });
      expect(lost.status).toBe("LOST");
      const after = await tx.device.count({ where: { storeId: f.fromStoreId, status: "IN_STOCK" } });
      expect(before - after).toBe(1);
      const ledger = await tx.stockLedger.findFirst({ where: { docNo: "ST-T-1" } });
      expect(ledger?.qtyDelta).toBe(-1);
      expect(ledger?.statusAfter).toBe("LOST");
      // 盘亏的机器不能再卖
      await expect(applyDeviceAction(tx, { deviceId: ids[1]!, action: "SELL", docType: "SALE", docNo: "SO-T-3", operatorId: f.userId })).rejects.toThrow();
    });
  });

  it("配件盘盈盘亏：余额与流水一致", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const start = (await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: f.fromStoreId, skuId: f.accessorySkuId } } }))?.qty ?? 0;
      await changeAccessoryStock(tx, { storeId: f.fromStoreId, skuId: f.accessorySkuId, qtyDelta: 10, docType: "PURCHASE_RECEIPT", docNo: "RI-T-4", operatorId: f.userId });
      const afterLoss = await changeAccessoryStock(tx, { storeId: f.fromStoreId, skuId: f.accessorySkuId, qtyDelta: -3, docType: "STOCKTAKE_LOSS", docNo: "ST-T-2", operatorId: f.userId });
      const afterGain = await changeAccessoryStock(tx, { storeId: f.fromStoreId, skuId: f.accessorySkuId, qtyDelta: 2, docType: "STOCKTAKE_GAIN", docNo: "ST-T-2", operatorId: f.userId });
      expect(afterLoss).toBe(start + 7);
      expect(afterGain).toBe(start + 9);
      const ledgers = await tx.stockLedger.findMany({ where: { docNo: "ST-T-2" }, orderBy: { id: "asc" } });
      expect(ledgers.map((l) => [l.qtyDelta, l.balanceAfter])).toEqual([
        [-3, start + 7],
        [2, start + 9],
      ]);
    });
  });
});
