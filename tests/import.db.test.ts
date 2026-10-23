import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { verifyPassword } from "@/server/auth/password";
import { commitImport, ImportError, precheckImport, revokeImport } from "@/server/import/import-service";
import { decryptPii, phoneColumns } from "@/server/pii/crypto";
import { changeAccessoryStock, revokeOpeningStock, StockError } from "@/server/stock/stock-service";
import { importProblems } from "../prisma/integrity-checks";
import { findReferences } from "@/server/db-refs";

// 数据导入（口径第 22 节，连本机库，事务回滚）：预检把问题一次列全、有问题整批不进；确认导入写库、建导入记录；
// 期初入库单的机器、配件能撤销（没动过时），动过的撤不了；系统里开过销售单就不能整批撤销。

class Rollback extends Error {}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });

type Fixture = {
  hq: CurrentUser;
  staff: CurrentUser;
  store: { code: string; id: number };
  deviceSku: { barcode: string; id: number };
  accessorySku: { barcode: string; id: number };
  existingCode: string;
  existingPhone: string;
};
let f: Fixture | null = null;

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

const asUser = (u: { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean }) =>
  ({ ...u, mustChangePassword: false, store: null, region: null }) as unknown as CurrentUser;

const csv = (text: string) => ({ bytes: new TextEncoder().encode(text), name: "测试.csv" });
const imei = (n: number) => String(950000000000000 + n);

beforeAll(async () => {
  try {
    const [hq, staff, store, deviceSku, accessorySku, device, customer] = await Promise.all([
      prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "STAFF", isActive: true }, orderBy: { id: "asc" } }),
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, isService: false, barcode: { not: null }, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, isService: false, barcode: { not: null }, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } }),
      prisma.device.findFirst({ where: { imei1: { not: null } }, orderBy: { id: "asc" } }),
      prisma.customer.findFirst({ orderBy: { id: "asc" } }),
    ]);
    if (hq && staff && store && deviceSku?.barcode && accessorySku?.barcode && device?.imei1 && customer) {
      f = {
        hq: asUser(hq),
        staff: asUser(staff),
        store: { code: store.code, id: store.id },
        deviceSku: { barcode: deviceSku.barcode, id: deviceSku.id },
        accessorySku: { barcode: accessorySku.barcode, id: accessorySku.id },
        existingCode: device.imei1,
        existingPhone: decryptPii(customer.phoneEnc),
      };
    }
  } catch {
    f = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("数据导入", () => {
  it("只有总部能导；表头缺列直接说", async (ctx) => {
    if (!f) return ctx.skip();
    const fx = f;
    await inRolledBackTx(async (tx) => {
      await expect(precheckImport(fx.staff, "STORES", csv("区域,门店编码,门店名称\n华东区,S999,测试店"), tx)).rejects.toThrow(ImportError);
      await expect(precheckImport(fx.hq, "STORES", csv("区域,门店名称\n华东区,测试店"), tx)).rejects.toThrow(/门店编码/);
    });
  });

  it("门店：问题一次列全、整批不进；没问题新建门店和区域", async (ctx) => {
    if (!f) return ctx.skip();
    const fx = f;
    await inRolledBackTx(async (tx) => {
      const bad = await precheckImport(fx.hq, "STORES", csv(`区域,门店编码,门店名称\n华东区,${fx.store.code},重复的\n测试区,T-01,甲店\n测试区,t-01,乙店\n测试区,T 02,\n`), tx);
      expect(bad.problems.map((p) => [p.line, p.column])).toEqual([
        [2, "门店编码"],
        [4, "门店编码"],
        [5, "门店编码"],
        [5, "门店名称"],
      ]);
      const result = await commitImport(fx.hq, "STORES", csv(`区域,门店编码,门店名称\n华东区,${fx.store.code},重复的`), {}, tx);
      expect(result.ok).toBe(false);
      // 停用的区域不往里建门店
      await tx.region.create({ data: { name: "停用测试区", isActive: false } });
      const inactive = await precheckImport(fx.hq, "STORES", csv("区域,门店编码,门店名称\n停用测试区,IMP-09,停用区的店"), tx);
      expect(inactive.problems.map((p) => p.message)).toEqual([expect.stringContaining("已停用")]);
      const ok = await commitImport(fx.hq, "STORES", csv("区域,门店编码,门店名称,地址\n导入测试区,IMP-01,导入一店,人民路 1 号\n导入测试区,imp-02,导入二店,"), {}, tx);
      if (!ok.ok) throw new Error(JSON.stringify(ok.check.problems));
      expect(ok.done.batchNo).toMatch(/^DR\d{12}$/);
      const stores = await tx.store.findMany({ where: { code: { in: ["IMP-01", "IMP-02"] } }, include: { region: true } });
      expect(stores.map((s) => [s.code, s.region.name])).toEqual([
        ["IMP-01", "导入测试区"],
        ["IMP-02", "导入测试区"],
      ]);
      const batch = await tx.importBatch.findUniqueOrThrow({ where: { id: ok.done.batchId } });
      expect(batch).toMatchObject({ kind: "STORES", rowCount: 2, createdCount: 2, status: "DONE" });
      expect(await tx.auditLog.count({ where: { action: "import.stores", entityId: String(batch.id) } })).toBe(1);
    });
  });

  it("员工：角色、门店要对；初始密码随机、只返回一次，第一次登录先改", async (ctx) => {
    if (!f) return ctx.skip();
    const fx = f;
    await inRolledBackTx(async (tx) => {
      const bad = await precheckImport(fx.hq, "USERS", csv(`账号,姓名,角色,门店编码\nhq,重名,店员,${fx.store.code}\nimp_a,甲,收银员,${fx.store.code}\nimp_b,乙,店员,NOPE\n`), tx);
      expect(bad.problems.map((p) => p.column)).toEqual(["账号", "角色", "门店编码"]);
      const ok = await commitImport(fx.hq, "USERS", csv(`账号,姓名,角色,门店编码\nimp_a,甲,店员,${fx.store.code}\nImp_B,乙,店长,${fx.store.code}\nimp_c,丙,总部,`), {}, tx);
      if (!ok.ok) throw new Error(JSON.stringify(ok.check.problems));
      expect(ok.done.passwords).toHaveLength(3);
      const b = await tx.user.findUniqueOrThrow({ where: { username: "imp_b" } });
      expect(b).toMatchObject({ role: "STORE_MANAGER", storeId: fx.store.id, mustChangePassword: true });
      const pw = ok.done.passwords!.find((p) => p.username === "imp_b")!.password;
      expect(pw).toMatch(/^[A-Za-z2-9]{12}$/);
      expect(await verifyPassword(pw, b.passwordHash)).toBe(true);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: "import.users" }, orderBy: { id: "desc" } });
      expect(JSON.stringify(audit.detail)).not.toContain(pw);
    });
  });

  it("商品：品牌、型号没有就建；已有的跳过；服务品类、型号挪品类、条码重复报出来", async (ctx) => {
    if (!f) return ctx.skip();
    const fx = f;
    await inRolledBackTx(async (tx) => {
      const existing = await tx.sku.findUniqueOrThrow({ where: { id: fx.deviceSku.id }, include: { model: { include: { brand: true, category: true } } } });
      const head = "品类,品牌,型号,颜色,容量,条码,指导价（元）\n";
      const bad = await precheckImport(
        fx.hq,
        "PRODUCTS",
        csv(`${head}服务,门店服务,保养,,,,99\n平板,${existing.model.brand.name},${existing.model.name},红,1TB,,9999\n手机,导入牌,X1,黑,128GB,IMP001,1999\n手机,导入牌,X1,白,128GB,IMP001,1999\n手机,导入牌,X2,黑,128GB,,一千\n`),
        tx,
      );
      expect(bad.problems.map((p) => [p.line, p.column])).toEqual([
        [2, "品类"],
        [3, "品类"],
        [5, "条码"],
        [6, "指导价"],
      ]);
      const ok = await commitImport(
        fx.hq,
        "PRODUCTS",
        csv(`${head}手机,导入牌,X1,黑,128GB,IMP001,1999\n手机,导入牌,X1,白,128GB,,1999.5\n${existing.model.category.name},${existing.model.brand.name},${existing.model.name},${existing.color ?? ""},${existing.storage ?? ""},,1\n`),
        {},
        tx,
      );
      if (!ok.ok) throw new Error(JSON.stringify(ok.check.problems));
      expect(ok.done).toMatchObject({ created: 2, skipped: 1 });
      const skus = await tx.sku.findMany({ where: { model: { name: "X1", brand: { name: "导入牌" } } }, orderBy: { id: "asc" } });
      expect(skus.map((s) => [s.name, s.barcode, s.guidePriceFen])).toEqual([
        ["X1 128GB 黑", "IMP001", 199900],
        ["X1 128GB 白", null, 199950],
      ]);
      expect((await tx.sku.findUniqueOrThrow({ where: { id: fx.deviceSku.id } })).guidePriceFen).toBe(existing.guidePriceFen); // 已有的不改价
    });
  });

  it("在库机器：码的格式、重复、科学计数法、商品种类都查；导入后在库、写期初流水；没动过能撤销，动过的撤不了", async (ctx) => {
    if (!f) return ctx.skip();
    const fx = f;
    await inRolledBackTx(async (tx) => {
      const head = "门店编码,条码,IMEI1,IMEI2,SN,成本\n";
      const bad = await precheckImport(
        fx.hq,
        "DEVICES",
        csv(
          `${head}${fx.store.code},${fx.deviceSku.barcode},${fx.existingCode},,,4000\n` +
            `${fx.store.code},${fx.deviceSku.barcode},9.5E+14,,,4000\n` +
            `${fx.store.code},${fx.deviceSku.barcode},${imei(1)},${imei(1)},,4000\n` +
            `NOPE,${fx.accessorySku.barcode},${imei(2)},,,4000\n` +
            `${fx.store.code},${fx.deviceSku.barcode},,,,4000\n` +
            `${fx.store.code},${fx.deviceSku.barcode},${imei(3)},,,\n`,
        ),
        tx,
      );
      expect(bad.problems.map((p) => [p.line, p.column])).toEqual([
        [2, "码"],
        [3, "IMEI1"],
        [4, "码"],
        [5, "门店编码"],
        [5, "商品"],
        [6, "IMEI1"],
        [7, "成本"],
      ]);
      expect(bad.problems[0]!.message).toContain("系统里已经有了");
      const ok = await commitImport(fx.hq, "DEVICES", csv(`${head}${fx.store.code},${fx.deviceSku.barcode},${imei(11)},${imei(12)},,4000.5\n${fx.store.code},${fx.deviceSku.barcode},,,IMPSN0001,3999\n`), {}, tx);
      if (!ok.ok) throw new Error(JSON.stringify(ok.check.problems));
      expect(ok.done.batchNo).toMatch(/^QC\d{12}$/);
      const devices = await tx.device.findMany({ where: { OR: [{ imei1: imei(11) }, { sn: "IMPSN0001" }] }, orderBy: { id: "asc" } });
      expect(devices.map((d) => [d.code, d.status, d.costFen, d.storeId])).toEqual([
        [imei(11), "IN_STOCK", 400050, fx.store.id],
        ["IMPSN0001", "IN_STOCK", 399900, fx.store.id],
      ]);
      const ledgers = await tx.stockLedger.findMany({ where: { docNo: ok.done.batchNo } });
      expect(ledgers.every((l) => l.docType === "OPENING" && l.qtyDelta === 1 && l.statusAfter === "IN_STOCK")).toBe(true);
      // 对账第 15 类：单子和流水对得上；改坏新建条数就报出来
      expect(await importProblems(tx as never)).toBe(0);
      await tx.importBatch.update({ where: { id: ok.done.batchId }, data: { createdCount: 1 } });
      expect(await importProblems(tx as never)).toBe(1);
      await tx.importBatch.update({ where: { id: ok.done.batchId }, data: { createdCount: 2 } });
      // 系统里开过销售单（演示数据）：不能整批撤销
      await expect(revokeImport(fx.hq, ok.done.batchId, tx)).rejects.toThrow(/开过销售单/);
      // 库存层（复查第 72 条）：这家店有进行中的盘点、待审批的单，都不撤；机器用在盘点单里（不写流水）也不撤
      await tx.stocktake.updateMany({ where: { storeId: fx.store.id, status: "IN_PROGRESS" }, data: { status: "VOIDED", voidedAt: new Date() } });
      await tx.approvalRequest.updateMany({ where: { storeId: fx.store.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      const st = await tx.stocktake.create({ data: { stocktakeNo: "ST-IMPORT-TEST", storeId: fx.store.id, createdById: fx.hq.id } });
      await tx.stocktakeItem.create({ data: { stocktakeId: st.id, skuId: fx.deviceSku.id, deviceId: devices[0]!.id, expectedQty: 1 } });
      await expect(revokeOpeningStock(tx, ok.done.batchNo)).rejects.toThrow(/先把这张盘点单作废再撤销/);
      // 确认过的盘点核对过这批机器：撤不了；作废的盘点不算（快核第 78 条），里面这几台的明细一起删掉
      await tx.stocktake.update({ where: { id: st.id }, data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedById: fx.hq.id } });
      await expect(revokeOpeningStock(tx, ok.done.batchNo)).rejects.toThrow(/用在盘点单里/);
      await tx.stocktake.update({ where: { id: st.id }, data: { status: "VOIDED", voidedAt: new Date(), confirmedAt: null, confirmedById: null } });
      // 大件不能按数量进出（机器号被清空的盘点行曾把手机记成了配件数量）
      await expect(changeAccessoryStock(tx, { storeId: fx.store.id, skuId: fx.deviceSku.id, qtyDelta: 2, docType: "STOCKTAKE_GAIN", docNo: "ST-IMPORT-TEST", operatorId: fx.hq.id })).rejects.toThrow(/大件/);
      // 动过的机器撤不了，没动过的能撤
      await tx.device.update({ where: { id: devices[0]!.id }, data: { status: "LOCKED" } });
      await expect(revokeOpeningStock(tx, ok.done.batchNo)).rejects.toThrow(StockError);
      await tx.device.update({ where: { id: devices[0]!.id }, data: { status: "IN_STOCK" } });
      expect(await revokeOpeningStock(tx, ok.done.batchNo)).toEqual({ devices: 2, accessories: 0 });
      expect(await tx.stocktakeItem.count({ where: { stocktakeId: st.id } })).toBe(0); // 作废的盘点里这台的明细删了
      expect(await tx.device.count({ where: { id: { in: devices.map((d) => d.id) } } })).toBe(0);
      expect(await tx.stockLedger.count({ where: { docNo: ok.done.batchNo } })).toBe(0);
    });
  });

  it("配件期初：加数量、写期初流水；同店同商品只能一行；之后有进出就撤不了", async (ctx) => {
    if (!f) return ctx.skip();
    const fx = f;
    await inRolledBackTx(async (tx) => {
      const head = "门店编码,条码,数量\n";
      const bad = await precheckImport(fx.hq, "ACCESSORIES", csv(`${head}${fx.store.code},${fx.accessorySku.barcode},5\n${fx.store.code},${fx.accessorySku.barcode},3\n${fx.store.code},${fx.deviceSku.barcode},1\n${fx.store.code},${fx.accessorySku.barcode},0\n`), tx);
      expect(bad.problems.map((p) => [p.line, p.column])).toEqual([
        [3, "商品"],
        [4, "商品"],
        [5, "数量"],
        [5, "商品"],
      ]);
      const before = (await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: fx.store.id, skuId: fx.accessorySku.id } } }))?.qty ?? 0;
      const ok = await commitImport(fx.hq, "ACCESSORIES", csv(`${head}${fx.store.code},${fx.accessorySku.barcode},7\n`), {}, tx);
      if (!ok.ok) throw new Error(JSON.stringify(ok.check.problems));
      const qty = async () => (await tx.accessoryStock.findUniqueOrThrow({ where: { storeId_skuId: { storeId: fx.store.id, skuId: fx.accessorySku.id } } })).qty;
      expect(await qty()).toBe(before + 7);
      const ledger = await tx.stockLedger.findFirstOrThrow({ where: { docNo: ok.done.batchNo } });
      expect(ledger).toMatchObject({ docType: "OPENING", qtyDelta: 7, balanceAfter: before + 7 });
      // 同一个文件再导一次：数量不能翻倍，预检就报出来（复查第 73 条）
      const again = await commitImport(fx.hq, "ACCESSORIES", csv(`${head}${fx.store.code},${fx.accessorySku.barcode},7\n`), {}, tx);
      expect(again.ok).toBe(false);
      expect(!again.ok && again.check.problems[0]!.message).toContain("已经期初入库过 7 件");
      expect(await qty()).toBe(before + 7);
      // 演示数据里这家店可能有待审批的单、进行中的盘点：先清掉（事务回滚，不影响库），只看“之后有进出”这一条
      await tx.stocktake.updateMany({ where: { storeId: fx.store.id, status: "IN_PROGRESS" }, data: { status: "VOIDED", voidedAt: new Date() } });
      await tx.approvalRequest.updateMany({ where: { storeId: fx.store.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      await changeAccessoryStock(tx, { storeId: fx.store.id, skuId: fx.accessorySku.id, qtyDelta: -1, docType: "SALE", docNo: "SO-IMPORT-TEST", operatorId: fx.hq.id });
      await expect(revokeOpeningStock(tx, ok.done.batchNo)).rejects.toThrow(/别的进出记录/);
    });
  });

  it("客户：要勾选合法收集；系统里已有的手机号跳过；新建的手机号加密、记是哪次导入的", async (ctx) => {
    if (!f) return ctx.skip();
    const fx = f;
    await inRolledBackTx(async (tx) => {
      const body = `姓名,手机号,备注\n老客户,${fx.existingPhone},\n导入甲,+86 139-0000-0001,VIP\n导入乙,13900000002,\n`;
      await expect(commitImport(fx.hq, "CUSTOMERS", csv(body), {}, tx)).rejects.toThrow(/合法收集/);
      const bad = await precheckImport(fx.hq, "CUSTOMERS", csv("姓名,手机号\n甲,13900000001\n乙,139 0000 0001\n丙,1.39E+10\n,13900000003\n"), tx);
      expect(bad.problems.map((p) => [p.line, p.column])).toEqual([
        [3, "手机号"],
        [4, "手机号"],
        [5, "姓名"],
      ]);
      const ok = await commitImport(fx.hq, "CUSTOMERS", csv(body), { legalConfirmed: true }, tx);
      if (!ok.ok) throw new Error(JSON.stringify(ok.check.problems));
      expect(ok.done).toMatchObject({ created: 2, skipped: 1 });
      const created = await tx.customer.findMany({ where: { importBatchId: ok.done.batchId }, orderBy: { id: "asc" } });
      expect(created.map((c) => [c.name, decryptPii(c.phoneEnc), c.phoneMasked, c.note])).toEqual([
        ["导入甲", "13900000001", "139****0001", "VIP"],
        ["导入乙", "13900000002", "139****0002", null],
      ]);
    });
  });
});

describe("撤销前查单据引用（复查第 72 条）", () => {
  it("用过的客户、机器查得出用在哪；没用过的查不出", async (ctx) => {
    if (!f) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const used = await tx.salesOrder.findFirstOrThrow({ where: { customerId: { not: null } }, select: { customerId: true } });
      expect(await findReferences(tx, "customers", [used.customerId!])).not.toBeNull(); // 维修单、销售单……查到哪张算哪张
      const fresh = await tx.customer.create({ data: { name: "引用测试", ...phoneColumns(`139${String(Date.now()).slice(-8)}`) } });
      expect(await findReferences(tx, "customers", [fresh.id])).toBeNull();
      const sold = await tx.salesOrderItem.findFirstOrThrow({ where: { deviceId: { not: null } }, select: { deviceId: true } });
      expect(await findReferences(tx, "devices", [sold.deviceId!], ["stock_ledgers"])).not.toBeNull();
    });
  });
});
