import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { entitlementPeriod, warrantyEndsOn } from "@/lib/entitlement";
import { scanEntitlementReminders } from "@/server/entitlement/entitlement-service";
import { createPurchaseOrder } from "@/server/purchase/purchase-service";
import { createReturnTx } from "@/server/sales/return-service";
import { createSalesOrderTx, SalesError, voidSalesOrderTx } from "@/server/sales/sales-service";
import { receiveDevices } from "@/server/stock/stock-service";
import { todayBizDate } from "@/server/stock/doc-no";
import { phoneColumns } from "@/server/pii/crypto";

// 服务权益（口径第 12 节，连本机库，事务回滚不留数据）：
// 碎屏险、延保开单不动库存、必须选客户、一行一份、生成权益；作废或退掉服务时权益失效；到期提醒每档只生成一次。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let fixture: { storeId: number; deviceSkuId: number; serviceSkuId: number; serviceMonths: number; serviceCostFen: number; user: CurrentUser } | null = null;

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

const imei = (seed: number) => String(940000000000000 + seed).padStart(15, "0");
const ymd = (x: Date) => x.toISOString().slice(0, 10);

beforeAll(async () => {
  try {
    const [store, deviceSku, serviceSku, hq] = await Promise.all([
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, guidePriceFen: { gt: 0 }, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, isService: true, serviceMonths: 12, serviceKind: "SCREEN_INSURANCE" }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    if (store && deviceSku && serviceSku && hq) {
      fixture = {
        storeId: store.id,
        deviceSkuId: deviceSku.id,
        serviceSkuId: serviceSku.id,
        serviceMonths: serviceSku.serviceMonths!,
        serviceCostFen: serviceSku.costPriceFen,
        user: { id: hq.id, username: hq.username, name: hq.name, role: hq.role, storeId: hq.storeId, regionId: hq.regionId, mustChangePassword: false, isActive: hq.isActive, store: null, region: null },
      };
    }
  } catch {
    fixture = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function setup(tx: Prisma.TransactionClient, seed: number, devices = 1) {
  const f = fixture!;
  const customer = await tx.customer.create({ data: { name: "权益测试", ...phoneColumns(`199${String(seed).padStart(8, "0")}`) } });
  const deviceIds = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: Array.from({ length: devices }, (_, i) => ({ sn: null, imei1: imei(seed * 10 + i), imei2: null })), costFen: 300000, docType: "PURCHASE_RECEIPT", docNo: `RI-ENT-${seed}`, operatorId: f.user.id });
  return { customerId: customer.id, deviceIds };
}

describe("服务权益（连本机库，事务回滚）", () => {
  it("开单带碎屏险：生成权益，到期日 = 营业日 + 12 个月 − 1 天，服务不扣库存、不写流水", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const { customerId, deviceIds } = await setup(tx, 1);
      const sale = await createSalesOrderTx(tx, f.user, {
        storeId: f.storeId,
        customerId,
        items: [{ deviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[0] }],
        paymentMethod: "CASH",
      });
      const e = await tx.serviceEntitlement.findFirstOrThrow({ where: { salesOrderId: sale.id } });
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: sale.id } });
      expect(e.customerId).toBe(customerId);
      expect(e.deviceId).toBe(deviceIds[0]);
      expect(e.status).toBe("ACTIVE");
      expect(ymd(e.startedOn)).toBe(ymd(order.bizDate));
      const expected = new Date(order.bizDate);
      expected.setUTCMonth(expected.getUTCMonth() + f.serviceMonths); // 营业日不在月底，直接加月
      expected.setUTCDate(expected.getUTCDate() - 1);
      if (order.bizDate.getUTCDate() <= 28) expect(ymd(e.expiresOn)).toBe(ymd(expected));
      const serviceItem = await tx.salesOrderItem.findUniqueOrThrow({ where: { id: e.salesOrderItemId } });
      expect(serviceItem.costFen).toBe(f.serviceCostFen);
      expect(await tx.stockLedger.count({ where: { docNo: sale.orderNo, skuId: f.serviceSkuId } })).toBe(0);
      expect(await tx.accessoryStock.count({ where: { skuId: f.serviceSkuId } })).toBe(0);
    });
  });

  it("开单带延保：从保修到期次日起算（营业日 + 12 个月），到期日再往后推服务期限", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    const extended = await prisma.sku.findFirst({ where: { isActive: true, serviceKind: "EXTENDED_WARRANTY" } });
    if (!extended) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const { customerId, deviceIds } = await setup(tx, 7);
      const sale = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, customerId, items: [{ deviceId: deviceIds[0] }, { skuId: extended.id, qty: 1, serviceDeviceId: deviceIds[0] }], paymentMethod: "CASH" });
      const e = await tx.serviceEntitlement.findFirstOrThrow({ where: { salesOrderId: sale.id } });
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: sale.id } });
      const period = entitlementPeriod("EXTENDED_WARRANTY", order.bizDate, extended.serviceMonths!);
      expect([ymd(e.startedOn), ymd(e.expiresOn)]).toEqual([ymd(period.startedOn), ymd(period.expiresOn)]);
      expect(ymd(e.startedOn)).toBe(ymd(new Date(warrantyEndsOn(order.bizDate).getTime() + 86400000)));
      // 延保要和机器同单买、保本单的机器：不绑机器的拦下
      await expect(createSalesOrderTx(tx, f.user, { storeId: f.storeId, customerId, items: [{ skuId: extended.id, qty: 1 }], paymentMethod: "CASH" })).rejects.toThrow("要和机器同一张单买");
    });
  });

  it("有服务就必须选客户；一行只能 1 份；保的机器要在本单里；同一台机器同一服务不能两份", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const { customerId, deviceIds } = await setup(tx, 2, 2);
      const sell = (items: { deviceId?: number; skuId?: number; qty?: number; serviceDeviceId?: number }[], withCustomer = true) =>
        createSalesOrderTx(tx, f.user, { storeId: f.storeId, customerId: withCustomer ? customerId : undefined, items, paymentMethod: "CASH" });
      await expect(sell([{ deviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[0] }], false)).rejects.toThrow(/先选客户/);
      await expect(sell([{ skuId: f.serviceSkuId, qty: 2 }])).rejects.toThrow(/一行只能 1 份/);
      await expect(sell([{ deviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[1] }])).rejects.toThrow(SalesError);
      await expect(
        sell([{ deviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[0] }]),
      ).rejects.toThrow(/选了两次/);
      // 一单两台机器各一份：两条权益分别保两台
      const sale = await sell([{ deviceId: deviceIds[0] }, { deviceId: deviceIds[1] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[1] }]);
      const rows = await tx.serviceEntitlement.findMany({ where: { salesOrderId: sale.id }, orderBy: { id: "asc" } });
      expect(rows.map((r) => r.deviceId)).toEqual(deviceIds);
    });
  });

  it("作废销售单：权益失效，服务不回库存", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const { customerId, deviceIds } = await setup(tx, 3);
      const sale = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, customerId, items: [{ deviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[0] }], paymentMethod: "CASH" });
      await voidSalesOrderTx(tx, f.user, sale.id, "测试作废");
      const e = await tx.serviceEntitlement.findFirstOrThrow({ where: { salesOrderId: sale.id } });
      expect(e.status).toBe("VOIDED");
      expect(e.voidedAt).not.toBeNull();
      expect(await tx.accessoryStock.count({ where: { skuId: f.serviceSkuId } })).toBe(0);
    });
  });

  it("退货：只退机器时服务照常有效但记“机器已退回”；退掉服务时权益失效", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const { customerId, deviceIds } = await setup(tx, 4);
      const sale = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, customerId, items: [{ deviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[0] }], paymentMethod: "CASH" });
      const items = await tx.salesOrderItem.findMany({ where: { orderId: sale.id }, orderBy: { id: "asc" } });
      const [deviceItem, serviceItem] = items;
      await createReturnTx(tx, f.user, { salesOrderId: sale.id, lines: [{ salesItemId: deviceItem!.id, qty: 1 }], refundFen: 0, refundMethod: "CASH" });
      const afterDevice = await tx.serviceEntitlement.findFirstOrThrow({ where: { salesOrderId: sale.id } });
      expect(afterDevice.status).toBe("ACTIVE");
      expect(afterDevice.deviceReturnedAt).not.toBeNull(); // 机器回库可能再卖给别人，不能再算它的保障
      await createReturnTx(tx, f.user, { salesOrderId: sale.id, lines: [{ salesItemId: serviceItem!.id, qty: 1 }], refundFen: 0, refundMethod: "CASH" });
      expect((await tx.serviceEntitlement.findFirstOrThrow({ where: { salesOrderId: sale.id } })).status).toBe("VOIDED");
      expect(await tx.stockLedger.count({ where: { skuId: f.serviceSkuId } })).toBe(0);
    });
  });

  it("到期提醒：剩 8～30 天、剩 0～7 天各生成一次，重复扫不会重复；失效的不提醒", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const { customerId, deviceIds } = await setup(tx, 5);
      const sale = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, customerId, items: [{ deviceId: deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1, serviceDeviceId: deviceIds[0] }], paymentMethod: "CASH" });
      const e = await tx.serviceEntitlement.findFirstOrThrow({ where: { salesOrderId: sale.id } });
      // 放到很远的将来，演示数据里的权益都不在区间里
      await tx.serviceEntitlement.update({ where: { id: e.id }, data: { expiresOn: new Date("2099-06-30T00:00:00Z") } });
      const scan = (today: string) => scanEntitlementReminders({ today: new Date(`${today}T00:00:00Z`), client: tx });
      expect(await scan("2099-05-01")).toEqual({ T30: 0, T7: 0 }); // 剩 60 天，不提醒
      expect(await scan("2099-06-10")).toEqual({ T30: 1, T7: 0 }); // 剩 20 天
      expect(await scan("2099-06-11")).toEqual({ T30: 0, T7: 0 }); // 同一档不重复
      expect(await scan("2099-06-25")).toEqual({ T30: 0, T7: 1 }); // 剩 5 天
      expect(await scan("2099-06-30")).toEqual({ T30: 0, T7: 0 });
      expect(await tx.entitlementReminder.count({ where: { entitlementId: e.id } })).toBe(2);
      // 作废后不再提醒
      const other = await setup(tx, 6);
      const sale2 = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, customerId: other.customerId, items: [{ deviceId: other.deviceIds[0] }, { skuId: f.serviceSkuId, qty: 1 }], paymentMethod: "CASH" });
      await tx.serviceEntitlement.updateMany({ where: { salesOrderId: sale2.id }, data: { expiresOn: new Date("2099-06-30T00:00:00Z") } });
      await voidSalesOrderTx(tx, f.user, sale2.id, "测试");
      expect(await scan("2099-06-26")).toEqual({ T30: 0, T7: 0 });
      expect(ymd(todayBizDate()).length).toBe(10);
    });
  });

  it("服务类商品不能开采购单", async (ctx) => {
    if (!fixture) return ctx.skip();
    await expect(createPurchaseOrder(fixture.user, { storeId: fixture.storeId, items: [{ skuId: fixture.serviceSkuId, qty: 1, unitCostFen: 100 }] })).rejects.toThrow(/不用采购/);
  });
});
