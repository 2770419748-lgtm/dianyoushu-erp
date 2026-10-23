import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { importSettlementCsv } from "@/server/carrier/carrier-service";
import { lockStoreDay } from "@/server/dailyclose/guard";
import { applyDeviceAction, changeAccessoryStock, StockError } from "@/server/stock/stock-service";
import { phoneColumns } from "@/server/pii/crypto";

// 并发测试（连本机库）：两个事务真的同时跑，验证“两人同时卖同一台 / 同时卖最后几件 / 同店同日排队”。
// 做法：事务 A 改完先不提交、停一会儿；事务 B 这时开始，读到的还是旧数据，按老写法会两个都成功。
// 这里会真的提交一次，所以每个用例最后都把测试写的流水删掉、把状态和数量改回原样（只动选中的那一台、那一行）。
// 连不上库（比如 CI）自动跳过。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ready = false;
let operatorId = 0;
let device: { id: number; status: "IN_STOCK" } | null = null;
let stock: { storeId: number; skuId: number; qty: number } | null = null;

beforeAll(async () => {
  try {
    const hq = await prisma.user.findFirst({ where: { role: "HQ" }, select: { id: true } });
    // 这里会真的提交改动，用第 3 家店的数据，和其他连库测试（用第一家、最后一家店）错开，避免并行跑时互相干扰
    const store = await prisma.store.findFirst({ orderBy: { id: "asc" }, skip: 2, select: { id: true } });
    if (!hq || !store) return;
    const d = await prisma.device.findFirst({ where: { storeId: store.id, status: "IN_STOCK" }, orderBy: { id: "desc" }, select: { id: true } });
    const s = await prisma.accessoryStock.findFirst({ where: { storeId: store.id, qty: { gte: 1, lte: 50 } }, orderBy: { id: "desc" }, select: { storeId: true, skuId: true, qty: true } });
    if (!d || !s) return;
    operatorId = hq.id;
    device = { id: d.id, status: "IN_STOCK" };
    stock = s;
    ready = true;
  } catch {
    ready = false;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("并发（连本机库）", () => {
  it("两个人同时卖同一台机器：只有先提交的成功，后一个报“刚被别人操作过”", async (ctx) => {
    if (!ready || !device) return ctx.skip();
    const id = device.id;
    const docNo = "RACE-TEST-DEVICE";
    try {
      const first = prisma.$transaction(async (tx) => {
        await applyDeviceAction(tx, { deviceId: id, action: "SELL", docType: "SALE", docNo, operatorId });
        await sleep(600); // 改完先不提交，让第二个事务读到旧状态
      });
      await sleep(150);
      const second = prisma.$transaction((tx) => applyDeviceAction(tx, { deviceId: id, action: "SELL", docType: "SALE", docNo, operatorId }));
      const [a, b] = await Promise.allSettled([first, second]);
      expect(a.status).toBe("fulfilled");
      expect(b.status).toBe("rejected");
      if (b.status === "rejected") expect(b.reason).toBeInstanceOf(StockError);
      expect(await prisma.stockLedger.count({ where: { docNo } })).toBe(1);
    } finally {
      await prisma.stockLedger.deleteMany({ where: { docNo } });
      await prisma.device.update({ where: { id }, data: { status: device.status } });
    }
  });

  it("两个人同时把最后几件配件全卖掉：只有一个成功，余额不会被扣成负数或少扣", async (ctx) => {
    if (!ready || !stock) return ctx.skip();
    const { storeId, skuId, qty } = stock;
    const docNo = "RACE-TEST-ACCESSORY";
    try {
      const first = prisma.$transaction(async (tx) => {
        await changeAccessoryStock(tx, { storeId, skuId, qtyDelta: -qty, docType: "SALE", docNo, operatorId });
        await sleep(600);
      });
      await sleep(150);
      const second = prisma.$transaction((tx) => changeAccessoryStock(tx, { storeId, skuId, qtyDelta: -qty, docType: "SALE", docNo, operatorId }));
      const [a, b] = await Promise.allSettled([first, second]);
      expect(a.status).toBe("fulfilled");
      expect(b.status).toBe("rejected");
      if (b.status === "rejected") expect(b.reason).toBeInstanceOf(StockError);
      const after = await prisma.accessoryStock.findUniqueOrThrow({ where: { storeId_skuId: { storeId, skuId } } });
      expect(after.qty).toBe(0);
    } finally {
      await prisma.stockLedger.deleteMany({ where: { docNo } });
      await prisma.accessoryStock.update({ where: { storeId_skuId: { storeId, skuId } }, data: { qty } });
    }
  });

  it("配件余额数据库层面也不能是负数（检查约束兜底）", async (ctx) => {
    if (!ready || !stock) return ctx.skip();
    const { storeId, skuId } = stock;
    await expect(prisma.accessoryStock.update({ where: { storeId_skuId: { storeId, skuId } }, data: { qty: -1 } })).rejects.toThrow();
  });

  it("同一家店同一营业日的锁：后来的事务要等前一个结束才能拿到", async (ctx) => {
    if (!ready) return ctx.skip();
    const day = new Date("2099-01-01"); // 用不会有真实单据的日子，只测排队
    const events: string[] = [];
    const first = prisma.$transaction(async (tx) => {
      await lockStoreDay(tx, 1, day);
      events.push("A 拿到锁");
      await sleep(500);
      events.push("A 结束");
    });
    await sleep(100);
    const second = prisma.$transaction(async (tx) => {
      await lockStoreDay(tx, 1, day);
      events.push("B 拿到锁");
    });
    const other = prisma.$transaction(async (tx) => {
      await lockStoreDay(tx, 2, day); // 别的门店不受影响
      events.push("别店拿到锁");
    });
    await Promise.all([first, second, other]);
    expect(events.indexOf("B 拿到锁")).toBeGreaterThan(events.indexOf("A 结束"));
    expect(events.indexOf("别店拿到锁")).toBeLessThan(events.indexOf("A 结束"));
  });
  it("同一运营商两个月的结算单同时导入：同一笔业务只结算一次（按运营商排队，运营商复查记录项 1）", async (ctx) => {
    if (!ready) return ctx.skip();
    const hq = await prisma.user.findFirst({ where: { role: "HQ" } });
    const store = await prisma.store.findFirst({ orderBy: { id: "asc" }, skip: 2, select: { id: true } });
    if (!hq || !store) return ctx.skip();
    const user = { ...hq, store: null, region: null } as CurrentUser;
    const months = ["2019-01", "2019-02"]; // 不会有真实结算单的月份
    const business = await prisma.carrierBusiness.create({
      data: { orderNo: "RACE-YY-0001", storeId: store.id, handledById: hq.id, carrier: "CTCC", bizType: "BROADBAND", ...phoneColumns("13800009951"), packageName: "并发测试", carrierOrderNo: "RACE-JS-0001", bizDate: new Date("2019-01-10"), expectedCommissionFen: 13000, clawbackMonths: 12, status: "ACTIVATED", activatedAt: new Date() },
    });
    try {
      const csv = "受理单号,佣金\nRACE-JS-0001,130";
      const results = await Promise.allSettled(months.map((month) => importSettlementCsv(user, { carrier: "CTCC", month, csv })));
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const paid = await prisma.carrierSettlementLine.count({ where: { businessId: business.id, result: { in: ["MATCHED", "DIFF"] }, clawbackFen: 0 } });
      expect(paid).toBe(1);
      const after = await prisma.carrierBusiness.findUniqueOrThrow({ where: { id: business.id } });
      expect([after.status, after.settledFen]).toEqual(["SETTLED", 13000]);
    } finally {
      const settlements = await prisma.carrierSettlement.findMany({ where: { carrier: "CTCC", month: { in: months } }, select: { id: true } });
      const ids = settlements.map((s) => s.id);
      await prisma.carrierBusiness.update({ where: { id: business.id }, data: { settlementId: null } });
      await prisma.carrierSettlementLine.deleteMany({ where: { settlementId: { in: ids } } });
      await prisma.carrierSettlement.deleteMany({ where: { id: { in: ids } } });
      await prisma.carrierBusiness.delete({ where: { id: business.id } });
      await prisma.auditLog.deleteMany({ where: { action: "carrier.settlement.import", entityId: { in: ids.map(String) } } });
    }
  });
});
