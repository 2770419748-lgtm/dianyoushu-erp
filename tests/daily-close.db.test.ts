import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { confirmDailyCloseTx, DailyCloseError, reopenDailyCloseTx } from "@/server/dailyclose/daily-close-service";
import { summarizeByMethod } from "@/server/dailyclose/summary";
import { createReturnTx } from "@/server/sales/return-service";
import { createSalesOrderTx, SalesError, voidSalesOrderTx } from "@/server/sales/sales-service";
import { todayBizDate } from "@/server/stock/doc-no";
import { changeAccessoryStock } from "@/server/stock/stock-service";

// 日结核心链路（连本机库，事务回滚不留数据）：
// 当天开两单（微信、现金+微信）、退一单 → 系统汇总对得上 → 确认后单据锁定、当天不能再开单 → 总部撤销后解锁。
// 用一家当天没有其他单据的门店（最后一家），避免和手工演示的数据混在一起。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let dbReady = false;
let fixture: { storeId: number; accessorySkuId: number; hq: CurrentUser } | null = null;

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
    await prisma.$queryRaw`SELECT 1`;
    const [store, accessorySku, hq] = await Promise.all([
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "desc" } }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    if (store && accessorySku && hq) {
      fixture = {
        storeId: store.id,
        accessorySkuId: accessorySku.id,
        hq: { id: hq.id, username: hq.username, name: hq.name, role: hq.role, storeId: hq.storeId, regionId: hq.regionId, isActive: hq.isActive, store: null, region: null },
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

describe("日结（连本机库，事务回滚）", () => {
  it("汇总对得上 → 确认锁单 → 当天不能再开单 → 撤销后解锁", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    const bizDate = todayBizDate();
    await inRolledBackTx(async (tx) => {
      // 这家店当天已有的单据（一般没有）先算进基数
      const baseline = summarizeByMethod(
        (await tx.payment.findMany({ where: { OR: [{ salesOrder: { storeId: f.storeId, bizDate, status: "COMPLETED" } }, { returnOrder: { storeId: f.storeId, bizDate } }] }, select: { method: true, amountFen: true } })),
      );
      await changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: 10, docType: "PURCHASE_RECEIPT", docNo: "RI-DC-1", operatorId: f.hq.id });

      const s1 = await createSalesOrderTx(tx, f.hq, { storeId: f.storeId, items: [{ skuId: f.accessorySkuId, qty: 2, unitPriceFen: 5000 }], payments: [{ method: "WECHAT", amountFen: 10000 }] });
      const s2 = await createSalesOrderTx(tx, f.hq, {
        storeId: f.storeId,
        items: [{ skuId: f.accessorySkuId, qty: 1, unitPriceFen: 8000 }],
        payments: [
          { method: "CASH", amountFen: 3000 },
          { method: "WECHAT", amountFen: 5000 },
        ],
      });
      const item = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: s1.id } });
      await createReturnTx(tx, f.hq, { salesOrderId: s1.id, lines: [{ salesItemId: item.id, qty: 1 }], refundFen: 5000, refundMethod: "WECHAT" });

      // 系统数：微信 10000 + 5000 − 5000 = 10000，现金 3000
      const wechat = baseline.WECHAT + 10000;
      const cash = baseline.CASH + 3000;

      // 少录现金不写备注 → 不让确认
      await expect(
        confirmDailyCloseTx(tx, f.hq, { storeId: f.storeId, bizDate: bizDate.toISOString().slice(0, 10), actuals: { ...baseline, WECHAT: wechat, CASH: cash - 100 } }),
      ).rejects.toThrow(/备注/);

      const result = await confirmDailyCloseTx(tx, f.hq, {
        storeId: f.storeId,
        bizDate: bizDate.toISOString().slice(0, 10),
        actuals: { ...baseline, WECHAT: wechat, CASH: cash },
      });
      expect(result.diffs).toEqual([]);
      const close = await tx.dailyClose.findUniqueOrThrow({ where: { storeId_bizDate: { storeId: f.storeId, bizDate } }, include: { lines: true } });
      expect(close.status).toBe("CONFIRMED");
      expect(close.lines.find((l) => l.method === "WECHAT")!.systemFen).toBe(wechat);
      expect(close.lines.find((l) => l.method === "CASH")!.systemFen).toBe(cash);

      // 锁单：单据挂上日结，不能作废；当天不能再开单
      expect((await tx.salesOrder.findUniqueOrThrow({ where: { id: s2.id } })).dailyCloseId).toBe(close.id);
      await expect(voidSalesOrderTx(tx, f.hq, s2.id, "")).rejects.toThrow(/日结/);
      await expect(createSalesOrderTx(tx, f.hq, { storeId: f.storeId, items: [{ skuId: f.accessorySkuId, qty: 1, unitPriceFen: 1000 }], payments: [{ method: "CASH", amountFen: 1000 }] })).rejects.toThrow(SalesError);

      // 撤销：只有总部、要写原因；撤销后解锁，可以作废
      await expect(reopenDailyCloseTx(tx, f.hq, f.storeId, bizDate, "")).rejects.toThrow(DailyCloseError);
      await reopenDailyCloseTx(tx, f.hq, f.storeId, bizDate, "补录一单");
      expect((await tx.salesOrder.findUniqueOrThrow({ where: { id: s2.id } })).dailyCloseId).toBeNull();
      await voidSalesOrderTx(tx, f.hq, s2.id, "测试撤销后作废");
    });
  });
});
