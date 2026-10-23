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
