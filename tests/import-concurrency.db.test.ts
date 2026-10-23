import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { commitImport, ImportError } from "@/server/import/import-service";

// 同一个文件同时导两次（2026-10-23 复查第 73、74 条）：配件数量不能翻倍，商品不能建出两个一样的。
// 要真的并发提交，不能放在回滚事务里：测完把建出来的期初流水、数量、商品、导入记录、日志都删掉。

const createdBatches: string[] = [];

afterAll(async () => {
  for (const batchNo of createdBatches) {
    const rows = await prisma.stockLedger.findMany({ where: { docNo: batchNo, docType: "OPENING", deviceId: null } });
    for (const r of rows) await prisma.accessoryStock.update({ where: { storeId_skuId: { storeId: r.storeId, skuId: r.skuId } }, data: { qty: { decrement: r.qtyDelta } } });
    await prisma.stockLedger.deleteMany({ where: { docNo: batchNo } });
    const batch = await prisma.importBatch.findUnique({ where: { batchNo } });
    if (batch) {
      await prisma.auditLog.deleteMany({ where: { entity: "import_batch", entityId: String(batch.id) } });
      await prisma.importBatch.delete({ where: { id: batch.id } });
    }
  }
  await prisma.sku.deleteMany({ where: { model: { brand: { name: "并发测试牌" } } } });
  await prisma.productModel.deleteMany({ where: { brand: { name: "并发测试牌" } } });
  await prisma.brand.deleteMany({ where: { name: "并发测试牌" } });
  await prisma.$disconnect();
});

const csv = (text: string) => ({ bytes: new TextEncoder().encode(text), name: "并发.csv" });

async function fixture() {
  try {
    const [hq, store, sku] = await Promise.all([
      prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } }),
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "desc" } }),
      prisma.sku.findFirst({ where: { isActive: true, isService: false, barcode: { not: null }, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "desc" } }),
    ]);
    if (!hq || !store || !sku) return null;
    return { hq: { ...hq, store: null, region: null } as unknown as CurrentUser, store, sku };
  } catch {
    return null;
  }
}

describe("同一个文件同时导两次（连本机库，真并发）", () => {
  it("配件期初：只进一次，另一次预检报“已经期初入库过”", async (ctx) => {
    const f = await fixture();
    if (!f) return ctx.skip();
    if ((await prisma.stockLedger.count({ where: { docType: "OPENING", storeId: f.store.id, skuId: f.sku.id } })) > 0) return ctx.skip();
    const before = (await prisma.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: f.store.id, skuId: f.sku.id } } }))?.qty ?? 0;
    const file = csv(`门店编码,条码,数量\n${f.store.code},${f.sku.barcode},10\n`);
    const results = await Promise.all([commitImport(f.hq, "ACCESSORIES", file), commitImport(f.hq, "ACCESSORIES", file)]);
    for (const r of results) if (r.ok) createdBatches.push(r.done.batchNo);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failed = results.find((r) => !r.ok);
    expect(failed && !failed.ok && failed.check.problems[0]!.message).toContain("已经期初入库过");
    expect((await prisma.accessoryStock.findUniqueOrThrow({ where: { storeId_skuId: { storeId: f.store.id, skuId: f.sku.id } } })).qty).toBe(before + 10);
  });

  it("商品：只建一个，另一次说没有要新建的", async (ctx) => {
    const f = await fixture();
    if (!f) return ctx.skip();
    const file = csv("品类,品牌,型号,颜色,容量,指导价\n手机,并发测试牌,并发 1,黑,128GB,999\n");
    const results = await Promise.allSettled([commitImport(f.hq, "PRODUCTS", file), commitImport(f.hq, "PRODUCTS", file)]);
    for (const r of results) if (r.status === "fulfilled" && r.value.ok) createdBatches.push(r.value.done.batchNo);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.ok)).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ImportError);
    expect(await prisma.sku.count({ where: { model: { brand: { name: "并发测试牌" } } } })).toBe(1);
  });
});

describe("撤销期初入库单和同时在跑的调拨（快核第 77 条）", () => {
  it("调拨已经锁住机器、还没提交时点撤销：撤销等它提交，再查出机器动过了，不删", async (ctx) => {
    const f = await fixture();
    const deviceSku = f ? await prisma.sku.findFirst({ where: { isActive: true, isService: false, barcode: { not: null }, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }) : null;
    if (!f || !deviceSku) return ctx.skip();
    const imei = `97${String(Date.now()).slice(-13)}`;
    const done = await commitImport(f.hq, "DEVICES", csv(`门店编码,条码,IMEI1,成本\n${f.store.code},${deviceSku.barcode},${imei},1000\n`));
    if (!done.ok) throw new Error(JSON.stringify(done.check.problems));
    createdBatches.push(done.done.batchNo);
    const device = await prisma.device.findUniqueOrThrow({ where: { code: imei } });
    let locked!: () => void;
    const lockedSignal = new Promise<void>((r) => (locked = r));
    // 模拟调拨申请：锁住机器，过一会儿才写“调拨锁定”流水、改状态、提交
    const transfer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM devices WHERE id = ${device.id} FOR UPDATE`;
      locked();
      await new Promise((r) => setTimeout(r, 800));
      await tx.stockLedger.create({ data: { docType: "TRANSFER_LOCK", docNo: "TR-RACE-TEST", storeId: device.storeId, skuId: device.skuId, deviceId: device.id, qtyDelta: 0, statusBefore: "IN_STOCK", statusAfter: "LOCKED", operatorId: f.hq.id } });
      await tx.device.update({ where: { id: device.id }, data: { status: "LOCKED" } });
    });
    await lockedSignal;
    const { revokeOpeningStock } = await import("@/server/stock/stock-service");
    const revoke = prisma.$transaction((tx) => revokeOpeningStock(tx, done.done.batchNo)).then(
      () => "撤了",
      (e: Error) => e.message,
    );
    await transfer;
    expect(await revoke).toMatch(/别的进出记录/);
    expect(await prisma.device.count({ where: { id: device.id } })).toBe(1);
    // 清理：调拨流水、机器（期初流水和导入记录在 afterAll 里清）
    await prisma.stockLedger.deleteMany({ where: { docNo: { in: ["TR-RACE-TEST", done.done.batchNo] } } });
    await prisma.device.delete({ where: { id: device.id } });
  });
});
