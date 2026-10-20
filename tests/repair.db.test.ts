import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { approveRepairTx, createRepairTx, declineRepairTx, finishRepairTx, pickupRepairTx, quoteRepairTx, RepairError, voidRepairTx } from "@/server/repair/repair-service";
import { createReturnTx } from "@/server/sales/return-service";
import { createSalesOrderTx, voidSalesOrderTx } from "@/server/sales/sales-service";
import { receiveDevices } from "@/server/stock/stock-service";
import { todayBizDate } from "@/server/stock/doc-no";

// 售后维修（口径第 13 节，连本机库，事务回滚不留数据）：接件规则、谁来付、碎屏险理赔一次、取机收款进日结、不动库存。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type Fixture = { storeId: number; deviceSkuId: number; screenSkuId: number; hq: CurrentUser; staff: CurrentUser | null; regional: CurrentUser | null };
let fixture: Fixture | null = null;

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

const imei = (seed: number) => String(960000000000000 + seed).padStart(15, "0");
const asUser = (u: { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean }) =>
  ({ ...u, store: null, region: null }) as CurrentUser;

beforeAll(async () => {
  try {
    const [store, deviceSku, screenSku, hq] = await Promise.all([
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, guidePriceFen: { gt: 0 }, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, serviceKind: "SCREEN_INSURANCE", serviceMonths: 12 } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    if (store && deviceSku && screenSku && hq) {
      const [staff, regional] = await Promise.all([
        prisma.user.findFirst({ where: { role: "STAFF", storeId: store.id, isActive: true } }),
        prisma.user.findFirst({ where: { role: "REGIONAL_MANAGER", regionId: store.regionId, isActive: true } }),
      ]);
      fixture = { storeId: store.id, deviceSkuId: deviceSku.id, screenSkuId: screenSku.id, hq: asUser(hq), staff: staff ? asUser(staff) : null, regional: regional ? asUser(regional) : null };
    }
  } catch {
    fixture = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 卖一台机器（可带碎屏险）给一个新客户 */
async function soldDevice(tx: Prisma.TransactionClient, seed: number, withScreenInsurance: boolean) {
  const f = fixture!;
  const customer = await tx.customer.create({ data: { name: "维修测试", phone: `197${String(seed).padStart(8, "0")}` } });
  const [deviceId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: imei(seed), imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: `RI-WX-${seed}`, operatorId: f.hq.id });
  const items = withScreenInsurance ? [{ deviceId }, { skuId: f.screenSkuId, qty: 1, serviceDeviceId: deviceId }] : [{ deviceId }];
  const sale = await createSalesOrderTx(tx, f.hq, { storeId: f.storeId, customerId: customer.id, items, paymentMethod: "CASH" });
  return { customerId: customer.id, deviceId: deviceId!, saleId: sale.id, code: imei(seed) };
}

describe("售后维修（连本机库，事务回滚）", () => {
  it("本店卖的机器摔碎屏、用碎屏险：接件带出购买记录，修好取机后碎屏险变已理赔，不收钱、不动库存；理赔过的不能再用、不能退、单不能作废", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const sold = await soldDevice(tx, 1, true);
      const ledgersBefore = await tx.stockLedger.count({ where: { deviceId: sold.deviceId } });
      const { id } = await createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: sold.customerId, code: sold.code, faultCategory: "SCREEN", faultDescription: "外屏碎了" });
      const received = await tx.repairOrder.findUniqueOrThrow({ where: { id } });
      expect([received.deviceId, received.salesOrderId, received.status]).toEqual([sold.deviceId, sold.saleId, "RECEIVED"]);
      expect(received.purchasedOn).not.toBeNull();
      // 屏幕不能走保修
      await expect(quoteRepairTx(tx, f.hq, id, { partsFen: 80000, laborFen: 5000, payer: "WARRANTY" })).rejects.toThrow(/人为损坏/);
      await quoteRepairTx(tx, f.hq, id, { partsFen: 80000, laborFen: 5000, costFen: 50000, payer: "SCREEN_INSURANCE" });
      const quoted = await tx.repairOrder.findUniqueOrThrow({ where: { id } });
      expect([quoted.status, quoted.chargeFen]).toEqual(["QUOTED", 0]);
      expect(quoted.entitlementId).not.toBeNull();
      await approveRepairTx(tx, f.hq, id);
      await finishRepairTx(tx, f.hq, id, "REPAIRED", "换了外屏");
      await pickupRepairTx(tx, f.hq, id, []);
      const closed = await tx.repairOrder.findUniqueOrThrow({ where: { id }, include: { payments: true } });
      expect([closed.status, closed.payments.length]).toEqual(["CLOSED", 0]);
      expect(closed.bizDate?.toISOString().slice(0, 10)).toBe(todayBizDate().toISOString().slice(0, 10));
      expect((await tx.serviceEntitlement.findUniqueOrThrow({ where: { id: quoted.entitlementId! } })).status).toBe("CLAIMED");
      expect(await tx.stockLedger.count({ where: { deviceId: sold.deviceId } })).toBe(ledgersBefore); // 客户的机器不写库存流水
      expect((await tx.device.findUniqueOrThrow({ where: { id: sold.deviceId } })).status).toBe("SOLD");

      // 再摔一次：碎屏险用掉了，只能自费
      const again = await createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: sold.customerId, code: sold.code, faultCategory: "SCREEN", faultDescription: "又碎了" });
      await expect(quoteRepairTx(tx, f.hq, again.id, { partsFen: 80000, laborFen: 5000, payer: "SCREEN_INSURANCE" })).rejects.toThrow(/没有生效中的碎屏险/);
      // 理赔过的碎屏险不能退，那张单也不能作废
      const serviceItem = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: sold.saleId, deviceId: null } });
      await expect(createReturnTx(tx, f.hq, { salesOrderId: sold.saleId, lines: [{ salesItemId: serviceItem.id, qty: 1 }], refundFen: 0, refundMethod: "CASH" })).rejects.toThrow(/理赔/);
      await expect(voidSalesOrderTx(tx, f.hq, sold.saleId, "测试")).rejects.toThrow(/理赔/);
    });
  });

  it("自费：收款合计要等于应付，收款记在今天、属于维修单；当天已日结不能结算", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const sold = await soldDevice(tx, 2, false);
      const { id } = await createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: sold.customerId, code: sold.code, faultCategory: "WATER", faultDescription: "进水" });
      await quoteRepairTx(tx, f.hq, id, { partsFen: 30000, laborFen: 10000, payer: "CUSTOMER" });
      expect((await tx.repairOrder.findUniqueOrThrow({ where: { id } })).chargeFen).toBe(40000);
      await approveRepairTx(tx, f.hq, id);
      await finishRepairTx(tx, f.hq, id, "REPAIRED", "");
      await expect(pickupRepairTx(tx, f.hq, id, [{ method: "WECHAT", amountFen: 30000 }])).rejects.toThrow(/还差/);
      await expect(pickupRepairTx(tx, f.hq, id, [{ method: "TRADE_IN", amountFen: 40000 }])).rejects.toThrow(RepairError);
      await pickupRepairTx(tx, f.hq, id, [{ method: "WECHAT", amountFen: 30000 }, { method: "CASH", amountFen: 10000 }]);
      const payments = await tx.payment.findMany({ where: { repairOrderId: id } });
      expect(payments.map((p) => p.amountFen).sort()).toEqual([10000, 30000]);

      // 今天已日结：再结算一张会被拦
      const second = await soldDevice(tx, 3, false);
      const r2 = await createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: second.customerId, code: second.code, faultCategory: "BATTERY", faultDescription: "不耐用" });
      await quoteRepairTx(tx, f.hq, r2.id, { partsFen: 20000, laborFen: 3000, payer: "WARRANTY" });
      await declineRepairTx(tx, f.hq, r2.id, "客户先不修");
      expect((await tx.repairOrder.findUniqueOrThrow({ where: { id: r2.id } })).chargeFen).toBe(0);
      await tx.dailyClose.upsert({
        where: { storeId_bizDate: { storeId: f.storeId, bizDate: todayBizDate() } },
        create: { closeNo: "DC-TEST-REPAIR", storeId: f.storeId, bizDate: todayBizDate(), status: "CONFIRMED" },
        update: { status: "CONFIRMED" },
      });
      await expect(pickupRepairTx(tx, f.hq, r2.id, [])).rejects.toThrow(/日结/);
    });
  });

  it("接件规则：店里库存的机器不能接；同一台没修完不能再接；外面买的要写机型、不能保修；店员不能作废、区域经理不能接件", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const [stockId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: imei(10), imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-WX-10", operatorId: f.hq.id });
      expect(stockId).toBeGreaterThan(0);
      const customer = await tx.customer.create({ data: { name: "外来机", phone: "19700000099" } });
      await expect(createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: customer.id, code: imei(10), faultCategory: "BATTERY", faultDescription: "x" })).rejects.toThrow(/在库/);

      await expect(createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: customer.id, code: "SNOUTSIDE001", faultCategory: "BOARD", faultDescription: "开不了机" })).rejects.toThrow(/机型/);
      const outside = await createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: customer.id, code: "SNOUTSIDE001", modelName: "iPhone 13 128GB", faultCategory: "BOARD", faultDescription: "开不了机" });
      await expect(createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: customer.id, code: "SNOUTSIDE001", modelName: "iPhone 13", faultCategory: "BOARD", faultDescription: "又来" })).rejects.toThrow(/没完结/);
      await expect(quoteRepairTx(tx, f.hq, outside.id, { partsFen: 1, laborFen: 1, payer: "WARRANTY" })).rejects.toThrow(/厂家/);

      if (f.staff) await expect(voidRepairTx(tx, f.staff, outside.id, "测试")).rejects.toThrow(/店长和总部/);
      if (f.regional) await expect(createRepairTx(tx, f.regional, { storeId: f.storeId, customerId: customer.id, code: "SNOUTSIDE002", modelName: "x", faultCategory: "OTHER", faultDescription: "x" })).rejects.toThrow(/不能办售后/);
      await voidRepairTx(tx, f.hq, outside.id, "接错了");
      // 作废后同一台可以重新接
      await createRepairTx(tx, f.hq, { storeId: f.storeId, customerId: customer.id, code: "SNOUTSIDE001", modelName: "iPhone 13 128GB", faultCategory: "BOARD", faultDescription: "重新接" });
    });
  });
});
