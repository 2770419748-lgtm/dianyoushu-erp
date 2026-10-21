import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { bjDateKey, bjDateTime, dateFromKey } from "@/lib/attendance";
import type { CurrentUser } from "@/server/auth/current-user";
import { generatePayroll, getPayrollPage, payrollCostByStore, publishPayroll, savePlan, setAdjustment, voidPayroll } from "@/server/hr/payroll-service";
import { runIntegrityChecks } from "../prisma/integrity-checks";

// 提成和工资条（口径第 19 节，连本机库，事务回滚不留数据）：按考勤扣缺勤、按开单算提成、奖惩、发布锁定、作废重算、
// 只有本人和总部看得到、按那天在哪家店分摊到门店。测试的人和单据都在事务里新建。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type Base = { a: { id: number; regionId: number }; b: { id: number }; hq: CurrentUser; deviceSkuId: number; serviceSkuId: number };
let base: Base | null = null;
const today = bjDateKey(new Date());
const [ty, tm] = today.split("-").map(Number) as [number, number];
const prev = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7); // 上个月，整月都过完了
const day = (n: number) => `${prev}-${String(n).padStart(2, "0")}`;

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
    const stores = await prisma.store.findMany({ where: { isActive: true }, orderBy: { id: "asc" }, take: 2 });
    const hq = await prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } });
    const deviceSku = await prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } });
    const serviceSku = await prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: { not: "DEVICE" } } } }, orderBy: { id: "asc" } });
    if (stores.length === 2 && hq && deviceSku && serviceSku) base = { a: stores[0]!, b: stores[1]!, hq: asUser(hq), deviceSkuId: deviceSku.id, serviceSkuId: serviceSku.id };
  } catch {
    base = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 测试店员：基本工资 4000、选了提成方案；上个月 1～10 号在 A 店早班（9、10 号没打卡算缺勤），11～15 号在 B 店早班 */
async function setup(tx: Prisma.TransactionClient) {
  const b = base!;
  const planId = await savePlan(b.hq, { name: "测试店员方案", salesRateBp: 100, perDeviceFen: 2000, perServiceFen: 1500, note: "" }, tx);
  const staff = asUser(await tx.user.create({ data: { username: "paytest_s", passwordHash: "x", name: "工资测试店员", role: "STAFF", storeId: b.a.id } }));
  const manager = asUser(await tx.user.create({ data: { username: "paytest_m", passwordHash: "x", name: "工资测试店长", role: "STORE_MANAGER", storeId: b.a.id } }));
  await tx.employeeProfile.create({ data: { userId: staff.id, baseSalaryFen: 400000, commissionPlanId: planId } });
  for (let n = 1; n <= 15; n++) {
    const storeId = n <= 10 ? b.a.id : b.b.id;
    await tx.shiftSchedule.create({ data: { storeId, userId: staff.id, date: dateFromKey(day(n)), shift: "MORNING", updatedById: manager.id } });
    if (n === 9 || n === 10) continue;
    await tx.attendancePunch.create({ data: { userId: staff.id, storeId, date: dateFromKey(day(n)), kind: "IN", at: bjDateTime(day(n), 8 * 60 + 55), createdById: staff.id } });
    await tx.attendancePunch.create({ data: { userId: staff.id, storeId, date: dateFromKey(day(n)), kind: "OUT", at: bjDateTime(day(n), 17 * 60 + 5), createdById: staff.id } });
  }
  // 上个月开了两单：一台主机 3000 元、一份碎屏险 100 元；又退了那台主机（退款 500 元算部分退）
  const device = await tx.device.create({ data: { code: "PAYTEST000000001", skuId: b.deviceSkuId, storeId: b.a.id, status: "SOLD", costFen: 200000 } });
  const order = await tx.salesOrder.create({ data: { orderNo: "SO-PAYTEST-1", storeId: b.a.id, salespersonId: staff.id, bizDate: dateFromKey(day(5)), subtotalFen: 300000, totalFen: 300000 } });
  const item = await tx.salesOrderItem.create({ data: { orderId: order.id, skuId: b.deviceSkuId, deviceId: device.id, unitPriceFen: 300000, lineTotalFen: 300000, costFen: 200000 } });
  const customer = await tx.customer.create({ data: { name: "工资测试客户", phone: "19900001111" } });
  const order2 = await tx.salesOrder.create({ data: { orderNo: "SO-PAYTEST-2", storeId: b.a.id, salespersonId: staff.id, customerId: customer.id, bizDate: dateFromKey(day(6)), subtotalFen: 10000, totalFen: 10000 } });
  const item2 = await tx.salesOrderItem.create({ data: { orderId: order2.id, skuId: b.serviceSkuId, unitPriceFen: 10000, lineTotalFen: 10000, costFen: 0 } });
  await tx.serviceEntitlement.create({ data: { customerId: customer.id, storeId: b.a.id, salesOrderId: order2.id, salesOrderItemId: item2.id, skuId: b.serviceSkuId, startedOn: dateFromKey(day(6)), expiresOn: dateFromKey(day(28)) } });
  const ret = await tx.returnOrder.create({ data: { orderNo: "RT-PAYTEST-1", storeId: b.a.id, salesOrderId: order.id, handledById: manager.id, bizDate: dateFromKey(day(20)), refundFen: 50000 } });
  await tx.returnOrderItem.create({ data: { returnOrderId: ret.id, salesItemId: item.id, skuId: b.deviceSkuId, deviceId: device.id, refundFen: 50000 } });
  return { staff, manager, planId };
}

describe("工资条（连本机库，事务回滚）", () => {
  it("按考勤扣缺勤、按开单算提成（扣掉退货）；奖惩要写原因；重算保留奖惩", async (ctx) => {
    if (!base) return ctx.skip();
    const b = base;
    await inRolledBackTx(async (tx) => {
      await tx.payrollRun.updateMany({ where: { month: prev, status: { not: "VOIDED" } }, data: { status: "VOIDED", voidedAt: new Date(), voidReason: "测试前清掉演示数据" } });
      const { staff, manager } = await setup(tx);
      await expect(generatePayroll(manager, prev, { db: tx })).rejects.toThrow("只有总部");
      const next = new Date(Date.UTC(ty, tm, 1)).toISOString().slice(0, 7);
      await expect(generatePayroll(b.hq, next, { db: tx })).rejects.toThrow("还没到");
      const r = await generatePayroll(b.hq, prev, { db: tx });
      expect(r.slipCount).toBeGreaterThan(0);
      const slip = await tx.payrollSlip.findFirstOrThrow({ where: { runId: r.runId, userId: staff.id } });
      const days = new Date(Date.UTC(ty, tm - 1, 0)).getUTCDate();
      expect(slip).toMatchObject({
        planName: "测试店员方案",
        baseSalaryFen: 400000,
        employedDays: days,
        baseFen: 400000,
        absentDays: 2,
        absenceDeductionFen: Math.round((2 * 400000) / days),
        salesFen: 300000 + 10000 - 50000,
        deviceQty: 0, // 卖了 1 台又退了 1 台
        serviceQty: 1,
        salesCommissionFen: 2600,
        deviceCommissionFen: 0,
        serviceCommissionFen: 1500,
        commissionFen: 4100,
        adjustmentFen: 0,
      });
      expect(slip.grossFen).toBe(400000 + 4100 - slip.absenceDeductionFen);
      expect(slip.storeDays).toEqual({ [String(b.a.id)]: 10, [String(b.b.id)]: 5 });

      await expect(setAdjustment(b.hq, slip.id, { adjustmentFen: 20000, note: "" }, tx)).rejects.toThrow("原因");
      await setAdjustment(b.hq, slip.id, { adjustmentFen: 20000, note: "全勤以外的销售奖" }, tx);
      const run1 = await tx.payrollRun.findUniqueOrThrow({ where: { id: r.runId } });
      expect(run1.grossFen).toBe(r.grossFen + 20000);
      await generatePayroll(b.hq, prev, { db: tx }); // 重算：奖惩保留
      const again = await tx.payrollSlip.findFirstOrThrow({ where: { runId: r.runId, userId: staff.id } });
      expect(again).toMatchObject({ adjustmentFen: 20000, adjustmentNote: "全勤以外的销售奖", grossFen: slip.grossFen + 20000 });
      expect((await runIntegrityChecks(tx as never)).hr).toBe(0);
    });
  });

  it("发布后锁定、本人能看、别人看不到；整月作废后能重新生成；工资按那天在哪家店分到门店", async (ctx) => {
    if (!base) return ctx.skip();
    const b = base;
    await inRolledBackTx(async (tx) => {
      await tx.payrollRun.updateMany({ where: { month: prev, status: { not: "VOIDED" } }, data: { status: "VOIDED", voidedAt: new Date(), voidReason: "测试前清掉演示数据" } });
      const { staff, manager } = await setup(tx);
      const r = await generatePayroll(b.hq, prev, { db: tx });
      const before = await getPayrollPage(staff, { month: prev }, new Date(), tx);
      expect(before.manage).toBe(false);
      if (!before.manage) expect(before.mine).toHaveLength(0); // 草稿员工看不到
      await publishPayroll(b.hq, r.runId, tx);
      await expect(publishPayroll(b.hq, r.runId, tx)).rejects.toThrow("已经发布");
      const slip = await tx.payrollSlip.findFirstOrThrow({ where: { runId: r.runId, userId: staff.id } });
      await expect(setAdjustment(b.hq, slip.id, { adjustmentFen: 100, note: "x" }, tx)).rejects.toThrow("发布了的工资不能改");
      await expect(generatePayroll(b.hq, prev, { db: tx })).rejects.toThrow("已经发布");
      expect(await tx.notification.count({ where: { userId: staff.id, title: `工资条：${prev}` } })).toBe(1);

      const mine = await getPayrollPage(staff, { month: prev }, new Date(), tx);
      if (mine.manage) throw new Error("店员不该是管理视图");
      expect(mine.mine.map((s) => s.userId)).toEqual([staff.id]);
      const mgr = await getPayrollPage(manager, { month: prev }, new Date(), tx);
      if (mgr.manage) throw new Error("店长不该是管理视图");
      expect(mgr.mine.every((s) => s.userId === manager.id)).toBe(true); // 店长看不到店员的

      const cost = await payrollCostByStore(tx, prev);
      expect(cost.published).toBe(true);
      const all = await tx.payrollSlip.aggregate({ where: { runId: r.runId }, _sum: { grossFen: true } });
      expect([...cost.byStore.values()].reduce((s, v) => s + v, 0)).toBe(all._sum.grossFen); // 分完一分不差
      await expect(payrollCostByStore(tx, "2026-13")).rejects.toThrow("月份不对");

      await expect(voidPayroll(b.hq, r.runId, "", tx)).rejects.toThrow("为什么作废");
      await voidPayroll(b.hq, r.runId, "基本工资录错了", tx);
      expect(await tx.notification.count({ where: { userId: staff.id, title: `工资条：${prev}` } })).toBe(0);
      expect((await payrollCostByStore(tx, prev)).published).toBe(false);
      const r2 = await generatePayroll(b.hq, prev, { db: tx });
      expect(r2.runId).not.toBe(r.runId);
    });
  });
});
