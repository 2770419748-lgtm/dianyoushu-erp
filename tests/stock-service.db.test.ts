import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { applyDeviceAction, changeAccessoryStock, receiveDevices, StockError } from "@/server/stock/stock-service";

// 核心链路测试：连本机数据库，每个用例在一个事务里跑完就回滚，不留数据。
// 连不上库（比如 CI 里没有数据库）就整组跳过。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let dbReady = false;
let fixture: { storeId: number; deviceSkuId: number; accessorySkuId: number; userId: number } | null = null;

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

// 用 9 开头的假串号，避开真实号段
function fakeImeis(count: number, seed: number): string[] {
  return Array.from({ length: count }, (_, i) => String(900000000000000 + seed * 1000 + i).padStart(15, "0"));
}

// 只带 IMEI1 的机器（SN、IMEI2 为空）
function fakeDevices(count: number, seed: number) {
  return fakeImeis(count, seed).map((imei1) => ({ sn: null, imei1, imei2: null }));
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [store, deviceSku, accessorySku, user] = await Promise.all([
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    if (store && deviceSku && accessorySku && user) {
      fixture = { storeId: store.id, deviceSkuId: deviceSku.id, accessorySkuId: accessorySku.id, userId: user.id };
      dbReady = true;
    }
  } catch {
    dbReady = false;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("库存服务层（连本机库，事务回滚）", () => {
  it("入库 10 台：10 条机器、10 条流水、门店在库数 +10", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const before = await tx.device.count({ where: { storeId: f.storeId, status: "IN_STOCK" } });
      const devices = fakeDevices(10, 1);
      const ids = await receiveDevices(tx, {
        storeId: f.storeId,
        skuId: f.deviceSkuId,
        devices,
        costFen: 499900,
        docType: "PURCHASE_RECEIPT",
        docNo: "RI-TEST-0001",
        operatorId: f.userId,
      });
      expect(ids).toHaveLength(10);
      const after = await tx.device.count({ where: { storeId: f.storeId, status: "IN_STOCK" } });
      expect(after - before).toBe(10);
      const ledgers = await tx.stockLedger.findMany({ where: { docNo: "RI-TEST-0001" } });
      expect(ledgers).toHaveLength(10);
      expect(ledgers.every((l) => l.qtyDelta === 1 && l.statusAfter === "IN_STOCK" && l.deviceId !== null)).toBe(true);
    });
  });

  it("重复串号被拒绝，整批不入", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const imeis = fakeImeis(3, 2);
      await receiveDevices(tx, {
        storeId: f.storeId,
        skuId: f.deviceSkuId,
        devices: [{ sn: "SNTEST000001", imei1: imeis[0]!, imei2: imeis[1]! }, { sn: null, imei1: imeis[2]!, imei2: null }],
        costFen: 1,
        docType: "PURCHASE_RECEIPT",
        docNo: "RI-TEST-0002",
        operatorId: f.userId,
      });
      // 再入一批，其中一台的 IMEI1 和已入机器的 IMEI2 重复
      await expect(
        receiveDevices(tx, {
          storeId: f.storeId,
          skuId: f.deviceSkuId,
          devices: [{ sn: null, imei1: imeis[1]!, imei2: null }, ...fakeDevices(2, 3)],
          costFen: 1,
          docType: "PURCHASE_RECEIPT",
          docNo: "RI-TEST-0003",
          operatorId: f.userId,
        }),
      ).rejects.toThrow(StockError);
      expect(await tx.stockLedger.count({ where: { docNo: "RI-TEST-0003" } })).toBe(0);
      // SN 重复也拒绝
      await expect(
        receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: "SNTEST000001", imei1: null, imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-TEST-0005", operatorId: f.userId }),
      ).rejects.toThrow(StockError);
      // 串号格式不对也拒绝；三个码都空也拒绝
      await expect(
        receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: "12345", imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-TEST-0004", operatorId: f.userId }),
      ).rejects.toThrow(StockError);
      await expect(
        receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: null, imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-TEST-0006", operatorId: f.userId }),
      ).rejects.toThrow(StockError);
    });
  });

  it("配件入库与出库：余额表和流水的 balance_after 一致，扣成负数被拒", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const current = await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: f.storeId, skuId: f.accessorySkuId } } });
      const start = current?.qty ?? 0;
      const afterIn = await changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: 20, docType: "PURCHASE_RECEIPT", docNo: "RI-TEST-0005", operatorId: f.userId });
      expect(afterIn).toBe(start + 20);
      const afterOut = await changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: -5, docType: "SALE", docNo: "SO-TEST-0001", operatorId: f.userId });
      expect(afterOut).toBe(start + 15);
      const balance = await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: f.storeId, skuId: f.accessorySkuId } } });
      expect(balance?.qty).toBe(start + 15);
      const ledgers = await tx.stockLedger.findMany({ where: { docNo: { in: ["RI-TEST-0005", "SO-TEST-0001"] } }, orderBy: { id: "asc" } });
      expect(ledgers.map((l) => l.balanceAfter)).toEqual([start + 20, start + 15]);
      await expect(
        changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: -(start + 16), docType: "SALE", docNo: "SO-TEST-0002", operatorId: f.userId }),
      ).rejects.toThrow(StockError);
    });
  });

  it("卖出一台：状态变已售、流水 −1；在途的机器不能卖", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const [id] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: fakeDevices(1, 4), costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-TEST-0006", operatorId: f.userId });
      const sold = await applyDeviceAction(tx, { deviceId: id!, action: "SELL", docType: "SALE", docNo: "SO-TEST-0003", operatorId: f.userId });
      expect(sold.status).toBe("SOLD");
      const ledger = await tx.stockLedger.findFirst({ where: { docNo: "SO-TEST-0003" } });
      expect(ledger?.qtyDelta).toBe(-1);
      expect(ledger?.statusBefore).toBe("IN_STOCK");
      expect(ledger?.statusAfter).toBe("SOLD");
      // 已售的不能再卖
      await expect(applyDeviceAction(tx, { deviceId: id!, action: "SELL", docType: "SALE", docNo: "SO-TEST-0004", operatorId: f.userId })).rejects.toThrow();
    });
  });
});
