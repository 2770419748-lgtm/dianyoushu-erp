import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { CarrierError, confirmBusinessTx, generateSimulatedSettlement, importSettlementCsv, listBusiness, registerBusinessTx, syncSimulatedStatus, voidBusinessTx } from "@/server/carrier/carrier-service";
import { createSalesOrderTx } from "@/server/sales/sales-service";
import { phoneColumns } from "@/server/pii/crypto";

// 运营商业务（口径第 14 节，连本机库，事务回滚不留数据）：登记要有政策、佣金按登记时记、谁能确认和作废、结算单导入对账和返销、模拟器。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type U = { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean };
type Fixture = { storeId: number; otherStoreId: number; accessorySkuId: number; hq: CurrentUser; manager: CurrentUser; staff: CurrentUser; staff2: CurrentUser; regional: CurrentUser | null };
let fixture: Fixture | null = null;

const asUser = (u: U) => ({ ...u, store: null, region: null }) as CurrentUser;

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

beforeAll(async () => {
  try {
    const [stores, hq, accessory] = await Promise.all([
      prisma.store.findMany({ where: { isActive: true }, orderBy: { id: "asc" }, take: 2 }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, isService: false, guidePriceFen: { gt: 0 }, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } }),
    ]);
    const store = stores[0];
    const other = stores[1];
    if (!store || !other || !hq || !accessory) return;
    const [manager, staffList, regional] = await Promise.all([
      prisma.user.findFirst({ where: { role: "STORE_MANAGER", storeId: store.id, isActive: true } }),
      prisma.user.findMany({ where: { role: "STAFF", storeId: store.id, isActive: true }, orderBy: { id: "asc" }, take: 2 }),
      prisma.user.findFirst({ where: { role: "REGIONAL_MANAGER", regionId: store.regionId, isActive: true } }),
    ]);
    if (!manager || staffList.length < 2) return;
    fixture = { storeId: store.id, otherStoreId: other.id, accessorySkuId: accessory.id, hq: asUser(hq), manager: asUser(manager), staff: asUser(staffList[0]!), staff2: asUser(staffList[1]!), regional: regional ? asUser(regional) : null };
  } catch {
    fixture = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 测试里自己配政策（演示库里有，空库里没有） */
async function setRule(tx: Prisma.TransactionClient, carrier: "CMCC" | "CUCC" | "CTCC" | "CBN", bizType: "NEW_LINE" | "PORT_IN" | "CONTRACT_PHONE" | "BROADBAND" | "PLAN_UPGRADE", commissionFen: number, isActive = true) {
  await tx.carrierCommissionRule.upsert({ where: { carrier_bizType: { carrier, bizType } }, create: { carrier, bizType, commissionFen, clawbackMonths: 6, isActive }, update: { commissionFen, clawbackMonths: 6, isActive } });
}

const base = (storeId: number, phone: string) => ({ storeId, carrier: "CMCC", bizType: "NEW_LINE", phone, packageName: "5G 畅享 129 元套餐", monthlyFeeFen: 12900 });

describe("运营商业务（连本机库，事务回滚）", () => {
  it("登记要有在用的政策；预计佣金按登记时的政策记，后来改政策不影响；号码、受理单号要合规", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setRule(tx, "CMCC", "NEW_LINE", 8000, false);
      await expect(registerBusinessTx(tx, f.staff, base(f.storeId, "13800009901"))).rejects.toThrow("还没配");
      await setRule(tx, "CMCC", "NEW_LINE", 8000);
      await expect(registerBusinessTx(tx, f.staff, base(f.storeId, "1380000990"))).rejects.toThrow("11 位手机号");
      await expect(registerBusinessTx(tx, f.staff, { ...base(f.storeId, "13800009901"), carrierOrderNo: "CM 001" })).rejects.toThrow("受理单号");
      const { id, orderNo } = await registerBusinessTx(tx, f.staff, { ...base(f.storeId, "13800009901"), carrierOrderNo: "CMT0001" });
      expect(orderNo).toMatch(/^YY\d{12}$/);
      await setRule(tx, "CMCC", "NEW_LINE", 9900);
      const row = await tx.carrierBusiness.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "SUBMITTED", handledById: f.staff.id, expectedCommissionFen: 8000, clawbackMonths: 6, carrierOrderNo: "CMT0001" });
      expect(await tx.auditLog.count({ where: { action: "carrier.register", entityId: String(id) } })).toBe(1);
    });
  });

  it("店员只能登记本店的；区域经理只读不能登记", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setRule(tx, "CMCC", "NEW_LINE", 8000);
      await expect(registerBusinessTx(tx, f.staff, base(f.otherStoreId, "13800009902"))).rejects.toThrow(CarrierError);
      if (f.regional) await expect(registerBusinessTx(tx, f.regional, base(f.storeId, "13800009902"))).rejects.toThrow("不能登记");
      await expect(registerBusinessTx(tx, f.hq, base(f.otherStoreId, "13800009902"))).resolves.toMatchObject({ orderNo: expect.any(String) });
    });
  });

  it("合约机挂本店销售单：客户自动带出；别家店的、作废的单挂不上", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setRule(tx, "CUCC", "CONTRACT_PHONE", 18000);
      const customer = await tx.customer.create({ data: { name: "合约测试", ...phoneColumns("19699990001") } });
      await tx.accessoryStock.upsert({ where: { storeId_skuId: { storeId: f.storeId, skuId: f.accessorySkuId } }, create: { storeId: f.storeId, skuId: f.accessorySkuId, qty: 5 }, update: { qty: { increment: 5 } } });
      const sale = await createSalesOrderTx(tx, f.hq, { storeId: f.storeId, customerId: customer.id, items: [{ skuId: f.accessorySkuId, qty: 1 }], paymentMethod: "CASH" });
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: sale.id } });
      const input = { ...base(f.storeId, "13800009903"), carrier: "CUCC", bizType: "CONTRACT_PHONE", salesOrderNo: order.orderNo };
      await expect(registerBusinessTx(tx, f.hq, { ...input, storeId: f.otherStoreId })).rejects.toThrow("本店没有销售单");
      const { id } = await registerBusinessTx(tx, f.manager, input);
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ salesOrderId: sale.id, customerId: customer.id, expectedCommissionFen: 18000 });
      await tx.salesOrder.update({ where: { id: sale.id }, data: { status: "VOIDED" } });
      await expect(registerBusinessTx(tx, f.manager, input)).rejects.toThrow("已作废");
    });
  });

  it("确认开通 / 失败：店员只能确认自己经办的；失败要写原因；确认过的不能再确认；店员不能作废，店长能，已结算的不能作废", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setRule(tx, "CMCC", "NEW_LINE", 8000);
      const a = await registerBusinessTx(tx, f.staff, base(f.storeId, "13800009904"));
      const b = await registerBusinessTx(tx, f.staff, base(f.storeId, "13800009905"));
      await expect(confirmBusinessTx(tx, f.staff2, a.id, { activated: true })).rejects.toThrow("自己经办");
      await confirmBusinessTx(tx, f.staff, a.id, { activated: true, carrierOrderNo: "CMT0004" });
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "ACTIVATED", carrierOrderNo: "CMT0004" });
      await expect(confirmBusinessTx(tx, f.staff, a.id, { activated: false, reason: "x" })).rejects.toThrow("已登记的业务才能");
      await expect(confirmBusinessTx(tx, f.manager, b.id, { activated: false, reason: " " })).rejects.toThrow("原因");
      await confirmBusinessTx(tx, f.manager, b.id, { activated: false, reason: "实名没过" });
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: "FAILED", failedReason: "实名没过" });

      await expect(voidBusinessTx(tx, f.staff, a.id, "登记错了")).rejects.toThrow("只有店长和总部");
      await expect(voidBusinessTx(tx, f.manager, a.id, "")).rejects.toThrow("作废原因");
      await voidBusinessTx(tx, f.manager, b.id, "登记重复了");
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: "VOIDED", voidedById: f.manager.id });
      await tx.carrierBusiness.update({ where: { id: a.id }, data: { status: "SETTLED", settledFen: 8000 } });
      await expect(voidBusinessTx(tx, f.hq, a.id, "登记错了")).rejects.toThrow("不能作废");
    });
  });

  it("导入结算单：按受理单号、号码对账，记实收、金额不符、没登记、漏给；同月不能再导；下个月的返销记扣回", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setRule(tx, "CTCC", "NEW_LINE", 7500);
      await setRule(tx, "CTCC", "BROADBAND", 13000);
      const mk = async (phone: string, bizType: string, carrierOrderNo?: string) => {
        const { id } = await registerBusinessTx(tx, f.staff, { ...base(f.storeId, phone), carrier: "CTCC", bizType, carrierOrderNo });
        await confirmBusinessTx(tx, f.staff, id, { activated: true });
        await tx.carrierBusiness.update({ where: { id }, data: { bizDate: new Date("2020-01-15T00:00:00.000Z") } });
        return id;
      };
      const a = await mk("13800009911", "NEW_LINE", "CTT0011");
      const b = await mk("13800009912", "BROADBAND");
      const c = await mk("13800009913", "NEW_LINE", "CTT0013");
      await expect(importSettlementCsv(f.manager, { carrier: "CTCC", month: "2020-01", csv: "受理单号,佣金\nCTT0011,75" }, tx)).rejects.toThrow("只有总部");
      await expect(importSettlementCsv(f.hq, { carrier: "CTCC", month: "2099-01", csv: "受理单号,佣金\nCTT0011,75" }, tx)).rejects.toThrow("过完的月份");
      await expect(importSettlementCsv(f.hq, { carrier: "CTCC", month: "2020-01", csv: "受理单号,佣金\nCTT0011,七十五" }, tx)).rejects.toThrow("第 2 行");

      const csv = "受理单号,办理号码,业务类型,佣金（元）,返销（元）\nCTT0011,,新号入网,75.00,0\n,13800009912,宽带,120.00,0\nCTX9999,13800009999,新号入网,75.00,0";
      const { id } = await importSettlementCsv(f.hq, { carrier: "CTCC", month: "2020-01", csv }, tx);
      const s = await tx.carrierSettlement.findUniqueOrThrow({ where: { id } });
      expect(s).toMatchObject({ source: "FILE", lineCount: 3, matchedCount: 1, diffCount: 1, unmatchedCount: 1, missingCount: 1, totalCommissionFen: 27000, totalClawbackFen: 0 });
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ status: "SETTLED", settledFen: 7500, settlementId: id });
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ status: "SETTLED", settledFen: 12000 });
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: c } })).toMatchObject({ status: "ACTIVATED", settledFen: null });
      expect(await tx.auditLog.count({ where: { action: "carrier.settlement.import", entityId: String(id) } })).toBe(1);
      await expect(importSettlementCsv(f.hq, { carrier: "CTCC", month: "2020-01", csv }, tx)).rejects.toThrow("已经对过账");

      // 下个月：上个月漏给的补上，已结算的那笔被返销
      const { id: next } = await importSettlementCsv(f.hq, { carrier: "CTCC", month: "2020-02", csv: "受理单号,佣金,返销\nCTT0013,75,0\nCTT0011,0,75" }, tx);
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: c } })).toMatchObject({ status: "SETTLED", settledFen: 7500, settlementId: next });
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ status: "CLAWED_BACK", settledFen: 7500, clawbackFen: 7500, settlementId: id });
      expect(await tx.carrierSettlement.findUniqueOrThrow({ where: { id: next } })).toMatchObject({ matchedCount: 2, missingCount: 0, totalClawbackFen: 7500 });
    });
  });

  it("模拟器：同步状态（店员只同步自己的）和生成模拟结算单（按这个月已开通的出单，带一行我们没登记的）", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setRule(tx, "CBN", "PLAN_UPGRADE", 2000);
      const mine = await registerBusinessTx(tx, f.staff, { ...base(f.storeId, "13800009921"), carrier: "CBN", bizType: "PLAN_UPGRADE" });
      const others = await registerBusinessTx(tx, f.staff2, { ...base(f.storeId, "13800009922"), carrier: "CBN", bizType: "PLAN_UPGRADE" });
      const r = await syncSimulatedStatus(f.staff, { db: tx, random: () => 0.5 });
      expect(r.failed).toBe(0);
      const a = await tx.carrierBusiness.findUniqueOrThrow({ where: { id: mine.id } });
      expect(a.status).toBe("ACTIVATED");
      expect(a.carrierOrderNo).toBeTruthy();
      expect((await tx.carrierBusiness.findUniqueOrThrow({ where: { id: others.id } })).status).toBe("SUBMITTED");
      await syncSimulatedStatus(f.manager, { db: tx, random: () => 0.99 });
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: others.id } })).toMatchObject({ status: "FAILED", failedReason: expect.any(String) });

      await tx.carrierBusiness.update({ where: { id: mine.id }, data: { bizDate: new Date("2020-03-10T00:00:00.000Z") } });
      await expect(generateSimulatedSettlement(f.staff, { carrier: "CBN", month: "2020-03" }, { db: tx })).rejects.toThrow("只有总部");
      const { id } = await generateSimulatedSettlement(f.hq, { carrier: "CBN", month: "2020-03" }, { db: tx, random: () => 0.5 });
      expect(await tx.carrierSettlement.findUniqueOrThrow({ where: { id } })).toMatchObject({ source: "SIMULATED", matchedCount: 1, unmatchedCount: 1, missingCount: 0 });
      expect(await tx.carrierBusiness.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ status: "SETTLED", settledFen: 2000 });
    });
  });

  it("受理单号：同一运营商没作废的不能重复，作废了可以再用；确认开通时也校验格式", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setRule(tx, "CMCC", "NEW_LINE", 8000);
      await setRule(tx, "CUCC", "NEW_LINE", 7000);
      const first = await registerBusinessTx(tx, f.staff, { ...base(f.storeId, "13800009931"), carrierOrderNo: "DUP-0001" });
      await expect(registerBusinessTx(tx, f.staff, { ...base(f.storeId, "13800009932"), carrierOrderNo: "DUP-0001" })).rejects.toThrow("已经登记在");
      await expect(registerBusinessTx(tx, f.staff, { ...base(f.storeId, "13800009932"), carrier: "CUCC", carrierOrderNo: "DUP-0001" })).resolves.toBeTruthy(); // 不同运营商不算重复
      const second = await registerBusinessTx(tx, f.staff, base(f.storeId, "13800009933"));
      await expect(confirmBusinessTx(tx, f.staff, second.id, { activated: true, carrierOrderNo: "中文 单号!" })).rejects.toThrow("字母、数字和横线");
      await expect(confirmBusinessTx(tx, f.staff, second.id, { activated: true, carrierOrderNo: "DUP-0001" })).rejects.toThrow("已经登记在");
      await voidBusinessTx(tx, f.manager, first.id, "登记错了");
      await confirmBusinessTx(tx, f.staff, second.id, { activated: true, carrierOrderNo: "DUP-0001" });
      expect((await tx.carrierBusiness.findUniqueOrThrow({ where: { id: second.id } })).carrierOrderNo).toBe("DUP-0001");
    });
  });

  it("业务明细：店员只看到自己经办的", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    const data = await listBusiness(f.staff, {});
    expect(data.rows.every((r) => r.handledBy.name === f.staff.name)).toBe(true);
    expect(data.can).toMatchObject({ register: true, void: false, manage: false });
  });
});
