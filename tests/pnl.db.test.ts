import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { bjDateKey, dateFromKey } from "@/lib/attendance";
import type { CurrentUser } from "@/server/auth/current-user";
import { getPnl, saveFixedExpenses } from "@/server/finance/pnl-service";

// 门店收支和利润表（口径第 19 节，连本机库，事务回滚不留数据）：一家新开的测试店，上个月开单、退货、运营商业务、维修、报销、工资、固定支出各来一笔，
// 看利润表每一格对不对；谁能看、谁能录固定支出；数据不全。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type Base = { regionId: number; otherRegionId: number | null; hq: CurrentUser; deviceSkuId: number };
let base: Base | null = null;
const today = bjDateKey(new Date());
const [ty, tm] = today.split("-").map(Number) as [number, number];
const prev = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
const day = (n: number) => dateFromKey(`${prev}-${String(n).padStart(2, "0")}`);

const asUser = (u: { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean }) => ({ ...u, store: null, region: null }) as CurrentUser;

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 120000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

beforeAll(async () => {
  try {
    const regions = await prisma.region.findMany({ where: { isActive: true }, orderBy: { id: "asc" }, take: 2 });
    const hq = await prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } });
    const sku = await prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } });
    if (regions[0] && hq && sku) base = { regionId: regions[0].id, otherRegionId: regions[1]?.id ?? null, hq: asUser(hq), deviceSkuId: sku.id };
  } catch {
    base = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("门店利润表（连本机库，事务回滚）", () => {
  it("每一格按口径算：销售扣退货、成本冲回、运营商、维修、报销按付款日期、固定支出；没录固定支出标数据不全", async (ctx) => {
    if (!base) return ctx.skip();
    const b = base;
    await inRolledBackTx(async (tx) => {
      const store = await tx.store.create({ data: { code: "ZT-PNL1", name: "利润测试店", regionId: b.regionId } });
      const mgr = asUser(await tx.user.create({ data: { username: "pnltest_m", passwordHash: "x", name: "利润测试店长", role: "STORE_MANAGER", storeId: store.id } }));
      const staff = asUser(await tx.user.create({ data: { username: "pnltest_s", passwordHash: "x", name: "利润测试店员", role: "STAFF", storeId: store.id } }));
      // 一台 3000 元（成本 2000），退了一台（退款 3000，成本冲回 2000）；另一台 5000 元（成本 4000）
      const mk = async (code: string, price: number, cost: number, d: number, no: string) => {
        const device = await tx.device.create({ data: { code, skuId: b.deviceSkuId, storeId: store.id, status: "SOLD", costFen: cost } });
        const order = await tx.salesOrder.create({ data: { orderNo: no, storeId: store.id, salespersonId: staff.id, bizDate: day(d), subtotalFen: price, totalFen: price } });
        const item = await tx.salesOrderItem.create({ data: { orderId: order.id, skuId: b.deviceSkuId, deviceId: device.id, unitPriceFen: price, lineTotalFen: price, costFen: cost } });
        return { order, item, device };
      };
      const first = await mk("PNLTEST000000001", 300000, 200000, 3, "SO-PNLTEST-1");
      await mk("PNLTEST000000002", 500000, 400000, 4, "SO-PNLTEST-2");
      const ret = await tx.returnOrder.create({ data: { orderNo: "RT-PNLTEST-1", storeId: store.id, salesOrderId: first.order.id, handledById: mgr.id, bizDate: day(8), refundFen: 300000 } });
      await tx.returnOrderItem.create({ data: { returnOrderId: ret.id, salesItemId: first.item.id, skuId: b.deviceSkuId, deviceId: first.device.id, refundFen: 300000 } });
      // 作废的单不算
      await tx.salesOrder.create({ data: { orderNo: "SO-PNLTEST-3", storeId: store.id, salespersonId: staff.id, bizDate: day(5), subtotalFen: 99900, totalFen: 99900, status: "VOIDED" } });
      // 运营商：一笔 80 元算，作废的不算
      const sample = await tx.carrierBusiness.findFirst({ select: { carrier: true, bizType: true } });
      if (sample) {
        const cb = { storeId: store.id, handledById: staff.id, carrier: sample.carrier, bizType: sample.bizType, phone: "13900001111", packageName: "测试套餐", bizDate: day(6), clawbackMonths: 6 };
        await tx.carrierBusiness.create({ data: { ...cb, orderNo: "YY-PNLTEST-1", expectedCommissionFen: 8000 } });
        await tx.carrierBusiness.create({ data: { ...cb, orderNo: "YY-PNLTEST-2", expectedCommissionFen: 5000, status: "VOIDED", voidedAt: new Date(), voidedById: mgr.id, voidReason: "测试" } });
      }
      // 报销：上个月付了 200 元（算）；上个月批了没付的不算
      const claimBase = { userId: staff.id, storeId: store.id, category: "OFFICE" as const, occurredOn: day(2), description: "测试" };
      await tx.expenseClaim.create({ data: { ...claimBase, claimNo: "BX-PNLTEST-1", amountFen: 20000, status: "PAID", paidOn: day(10), payMethod: "BANK", paidById: b.hq.id } });
      await tx.expenseClaim.create({ data: { ...claimBase, claimNo: "BX-PNLTEST-2", amountFen: 30000, status: "APPROVED" } });

      const r1 = await getPnl(mgr, { month: prev }, new Date(), tx);
      expect(r1.rows).toHaveLength(1); // 店长只有本店
      const row = r1.rows[0]!;
      expect(row.numbers).toMatchObject({ salesFen: 500000, goodsCostFen: 400000, expenseFen: 20000, fixedFen: 0, fixedEntered: false });
      if (sample) expect(row.numbers.carrierFen).toBe(8000);
      expect(row.numbers.missing).toContain("固定支出没录");
      expect(row.canEdit).toBe(true);

      await expect(saveFixedExpenses(staff, { storeId: store.id, month: prev, items: [{ category: "RENT", amountFen: 100 }] }, { db: tx })).rejects.toThrow("店长（本店）和总部");
      await expect(saveFixedExpenses(mgr, { storeId: store.id, month: prev, items: [{ category: "RENT", amountFen: -1 }] }, { db: tx })).rejects.toThrow("0～10 万元");
      await saveFixedExpenses(mgr, { storeId: store.id, month: prev, items: [{ category: "RENT", amountFen: 2000000, note: "月租" }, { category: "UTILITIES", amountFen: 0 }] }, { db: tx });
      const r2 = await getPnl(mgr, { month: prev }, new Date(), tx);
      const n = r2.rows[0]!.numbers;
      expect(n).toMatchObject({ fixedFen: 2000000, fixedEntered: true });
      expect(n.missing).not.toContain("固定支出没录");
      expect(n.profitFen).toBe(n.grossFen - n.expenseFen - n.payrollFen - n.fixedFen);
      expect(n.grossFen).toBe(n.revenueFen - n.costFen);
      await saveFixedExpenses(mgr, { storeId: store.id, month: prev, items: [{ category: "RENT", amountFen: 2100000 }] }, { db: tx }); // 改
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: "pnl.fixed.save", entityId: String(store.id) }, orderBy: { id: "desc" } })).detail).toMatchObject({ before: { RENT: 2000000, UTILITIES: 0 }, after: { RENT: 2100000 } });
    });
  });

  it("谁能看：店员不能看；区域经理看辖区、不能录；总部全部、有总部行和合计", async (ctx) => {
    if (!base) return ctx.skip();
    const b = base;
    await inRolledBackTx(async (tx) => {
      const staff = asUser(await tx.user.create({ data: { username: "pnltest_s2", passwordHash: "x", name: "利润测试店员二", role: "STAFF", storeId: (await tx.store.findFirstOrThrow({ where: { regionId: b.regionId } })).id } }));
      await expect(getPnl(staff, { month: prev }, new Date(), tx)).rejects.toThrow("店长、区域经理和总部");
      const rm = asUser(await tx.user.create({ data: { username: "pnltest_r", passwordHash: "x", name: "利润测试区域经理", role: "REGIONAL_MANAGER", regionId: b.regionId } }));
      const r = await getPnl(rm, { month: prev }, new Date(), tx);
      const inRegion = await tx.store.count({ where: { regionId: b.regionId, isActive: true } });
      expect(r.rows).toHaveLength(inRegion);
      expect(r.rows.every((x) => !x.canEdit)).toBe(true);
      if (inRegion > 1) expect(r.total).not.toBeNull();
      const h = await getPnl(b.hq, { month: prev }, new Date(), tx);
      expect(h.rows.at(-1)?.key).toBe("hq");
      expect(h.total!.profitFen).toBe(h.rows.reduce((s, x) => s + x.numbers.profitFen, 0));
      const futureMonth = new Date(Date.UTC(ty, tm, 1)).toISOString().slice(0, 7);
      expect((await getPnl(b.hq, { month: futureMonth }, new Date(), tx)).month).toBe(prev); // 还没到的月份按上个月
      await expect(saveFixedExpenses(b.hq, { storeId: r.rows[0]!.storeId, month: futureMonth, items: [{ category: "RENT", amountFen: 1 }] }, { db: tx })).rejects.toThrow("还没到");
    });
  });
});
