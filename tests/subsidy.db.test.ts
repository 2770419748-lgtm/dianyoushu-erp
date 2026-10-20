import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { createReturnTx } from "@/server/sales/return-service";
import { createSalesOrderTx, voidSalesOrderTx } from "@/server/sales/sales-service";
import { receiveDevices } from "@/server/stock/stock-service";
import { createClaimsTx, importPlatformResults, markReturnedTx, savePolicy, simulateReview, simulateSettle, submitClaimTx } from "@/server/subsidy/subsidy-service";
import { runIntegrityChecks } from "../prisma/integrity-checks";

// 国补（口径第 15 节，连本机库，事务回滚不留数据）：开单立减和校验、作废退货撤销、提交审核、平台结果、模拟器、对账自检第 9 类。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type U = { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean };
type Fixture = { storeId: number; phoneSkuId: number; phoneCategoryId: number; priceFen: number; hq: CurrentUser; staff: CurrentUser; manager: CurrentUser; regional: CurrentUser | null };
let fixture: Fixture | null = null;

const asUser = (u: U) => ({ ...u, store: null, region: null }) as CurrentUser;
const imei = (seed: number) => String(970000000000000 + seed).padStart(15, "0");

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

beforeAll(async () => {
  try {
    const [store, sku, hq] = await Promise.all([
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, guidePriceFen: { gt: 100000, lte: 500000 }, model: { category: { name: "手机" } } }, orderBy: { id: "asc" }, include: { model: { select: { categoryId: true } } } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    if (!store || !sku || !hq) return;
    const [staff, manager, regional] = await Promise.all([
      prisma.user.findFirst({ where: { role: "STAFF", storeId: store.id, isActive: true } }),
      prisma.user.findFirst({ where: { role: "STORE_MANAGER", storeId: store.id, isActive: true } }),
      prisma.user.findFirst({ where: { role: "REGIONAL_MANAGER", regionId: store.regionId, isActive: true } }),
    ]);
    if (!staff || !manager) return;
    fixture = { storeId: store.id, phoneSkuId: sku.id, phoneCategoryId: sku.model.categoryId, priceFen: sku.guidePriceFen, hq: asUser(hq), staff: asUser(staff), manager: asUser(manager), regional: regional ? asUser(regional) : null };
  } catch {
    fixture = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 测试里自己配今年的手机政策（演示库里有，空库里没有） */
async function setPolicy(tx: Prisma.TransactionClient) {
  const f = fixture!;
  const year = new Date().getUTCFullYear();
  const data = { rateBp: 1500, capFen: 50000, priceCapFen: 600000, startsOn: new Date(Date.UTC(year - 1, 0, 1)), endsOn: new Date(Date.UTC(year + 1, 11, 31)), isActive: true };
  await tx.subsidyPolicy.upsert({ where: { categoryId: f.phoneCategoryId }, create: { categoryId: f.phoneCategoryId, ...data }, update: data });
}

/** 卖一台新手机给一个新客户，用国补 */
async function subsidizedSale(tx: Prisma.TransactionClient, seed: number, opts: { code?: string; user?: CurrentUser; customerId?: number } = {}) {
  const f = fixture!;
  const customerId = opts.customerId ?? (await tx.customer.create({ data: { name: "国补测试", phone: `196${String(seed).padStart(8, "0")}` } })).id;
  const [deviceId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.phoneSkuId, devices: [{ sn: null, imei1: imei(seed), imei2: null }], costFen: 100000, docType: "PURCHASE_RECEIPT", docNo: `RI-GB-${seed}`, operatorId: f.hq.id });
  const subsidyFen = Math.min(Math.round((f.priceFen * 1500) / 10000), 50000);
  const sale = await createSalesOrderTx(tx, opts.user ?? f.hq, {
    storeId: f.storeId,
    customerId,
    items: [{ deviceId }],
    subsidy: { qualificationCode: opts.code ?? `TESTGB${String(seed).padStart(6, "0")}1` },
    payments: [{ method: "WECHAT", amountFen: f.priceFen - subsidyFen }],
  });
  return { saleId: sale.id, customerId, deviceId: deviceId!, subsidyFen };
}

describe("国补（连本机库，事务回滚）", () => {
  it("政策日期要是真实日期：2026-02-30 不能存（不会滚成 3 月 2 日）", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await expect(savePolicy(f.hq, { categoryId: f.phoneCategoryId, rateBp: 1500, capFen: 50000, priceCapFen: 600000, startsOn: "2026-02-30", endsOn: "2026-12-31" })).rejects.toThrow("不是一个真实的日期");
  });

  it("同一个资格码已经在没撤销的国补单上：再建国补单被数据库唯一索引拦下，换成人话", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setPolicy(tx);
      const first = await subsidizedSale(tx, 41);
      const claim = await tx.subsidyClaim.findFirstOrThrow({ where: { salesOrderId: first.saleId } });
      const customer = await tx.customer.create({ data: { name: "国补测试", phone: "19600000042" } });
      const [deviceId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.phoneSkuId, devices: [{ sn: null, imei1: imei(42), imei2: null }], costFen: 100000, docType: "PURCHASE_RECEIPT", docNo: "RI-GB-42", operatorId: f.hq.id });
      const plain = await createSalesOrderTx(tx, f.hq, { storeId: f.storeId, customerId: customer.id, items: [{ deviceId }], paymentMethod: "CASH" });
      const item = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: plain.id } });
      // 模拟“另一家店同时开单、先查都没查到”：直接建第二张，用同一个码
      await expect(createClaimsTx(tx, { storeId: f.storeId, salesOrderId: plain.id, customerId: customer.id, bizDate: claim.bizDate, code: claim.qualificationCode, lines: [{ salesOrderItemId: item.id, deviceId: deviceId!, policyId: claim.policyId, categoryId: claim.categoryId, baseFen: f.priceFen, subsidyFen: 100 }] })).rejects.toThrow("刚被别的单用了");
    });
  });

  it("开单用国补：生成国补单和一笔“国补立减”，顾客付应收减补贴；校验客户、资格码、每人每类一台", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setPolicy(tx);
      const { saleId, customerId, deviceId, subsidyFen } = await subsidizedSale(tx, 1, { user: f.staff });
      const claim = await tx.subsidyClaim.findFirstOrThrow({ where: { salesOrderId: saleId } });
      expect(claim).toMatchObject({ status: "PENDING", customerId, deviceId, subsidyFen, basePriceFen: f.priceFen, storeId: f.storeId });
      expect(claim.claimNo).toMatch(/^GB\d{12}$/);
      const payments = await tx.payment.findMany({ where: { salesOrderId: saleId }, orderBy: { id: "asc" } });
      expect(payments.map((p) => [p.method, p.amountFen])).toEqual([["SUBSIDY", subsidyFen], ["WECHAT", f.priceFen - subsidyFen]]);
      expect(payments[0]!.reference).toBe(claim.qualificationCode);

      // 同一个客户再买一台手机：每人每类一台
      await expect(subsidizedSale(tx, 2, { customerId })).rejects.toThrow("已经用过一次手机国补");
      // 同一个资格码不能再用
      await expect(subsidizedSale(tx, 3, { code: claim.qualificationCode })).rejects.toThrow("已经在国补单");
      // 资格码格式、演示里尾号 0000 的过期
      await expect(subsidizedSale(tx, 4, { code: "短" })).rejects.toThrow("资格码");
      await expect(subsidizedSale(tx, 5, { code: "TESTGB0000050000" })).rejects.toThrow("已过期");
      // 没选客户
      const [d6] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.phoneSkuId, devices: [{ sn: null, imei1: imei(6), imei2: null }], costFen: 100000, docType: "PURCHASE_RECEIPT", docNo: "RI-GB-6", operatorId: f.hq.id });
      await expect(createSalesOrderTx(tx, f.hq, { storeId: f.storeId, items: [{ deviceId: d6 }], subsidy: { qualificationCode: "TESTGB0000061" }, paymentMethod: "CASH" })).rejects.toThrow("要先选客户");
    });
  });

  it("作废销售单：国补单撤销；退货：退款只到顾客付的部分，没到账的撤销、到账的变需退回，总部标已退回", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setPolicy(tx);
      const voided = await subsidizedSale(tx, 11);
      await voidSalesOrderTx(tx, f.manager, voided.saleId, "开错单");
      expect((await tx.subsidyClaim.findFirstOrThrow({ where: { salesOrderId: voided.saleId } })).status).toBe("CANCELLED");

      const returned = await subsidizedSale(tx, 12);
      const item = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: returned.saleId } });
      await expect(createReturnTx(tx, f.hq, { salesOrderId: returned.saleId, lines: [{ salesItemId: item.id, qty: 1 }], refundFen: f.priceFen, refundMethod: "WECHAT" })).rejects.toThrow("国补");
      await createReturnTx(tx, f.hq, { salesOrderId: returned.saleId, lines: [{ salesItemId: item.id, qty: 1 }], refundFen: f.priceFen - returned.subsidyFen, refundMethod: "WECHAT" });
      expect((await tx.subsidyClaim.findFirstOrThrow({ where: { salesOrderId: returned.saleId } })).status).toBe("CANCELLED");

      // 到账之后才退货：需退回 → 总部标已退回
      const settled = await subsidizedSale(tx, 13);
      const claim = await tx.subsidyClaim.findFirstOrThrow({ where: { salesOrderId: settled.saleId } });
      await tx.subsidyClaim.update({ where: { id: claim.id }, data: { status: "SETTLED", settledAt: new Date(), settledFen: claim.subsidyFen, submittedAt: new Date(), reviewedAt: new Date(), invoiceNo: "FPTEST000013" } });
      const settledItem = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: settled.saleId } });
      await createReturnTx(tx, f.hq, { salesOrderId: settled.saleId, lines: [{ salesItemId: settledItem.id, qty: 1 }], refundFen: f.priceFen - settled.subsidyFen, refundMethod: "WECHAT" });
      expect((await tx.subsidyClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe("RETURN_DUE");
      await expect(markReturnedTx(tx, f.manager, claim.id)).rejects.toThrow("只有总部");
      await markReturnedTx(tx, f.hq, claim.id);
      expect((await tx.subsidyClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe("RETURNED");

      // 撤销、退回的不占“每人每类一台”的名额：同一个客户可以再用国补买一台
      await expect(subsidizedSale(tx, 14, { customerId: voided.customerId })).resolves.toMatchObject({ saleId: expect.any(Number) });

      const checks = await runIntegrityChecks(tx as unknown as PrismaClient);
      expect(checks.subsidy).toBe(0);
    });
  });

  it("提交审核要发票号；被驳回的能重新提交；区域经理不能提交", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setPolicy(tx);
      const { saleId } = await subsidizedSale(tx, 21);
      const claim = await tx.subsidyClaim.findFirstOrThrow({ where: { salesOrderId: saleId } });
      if (f.regional) await expect(submitClaimTx(tx, f.regional, claim.id, "FP2026102100")).rejects.toThrow("不能提交");
      await expect(submitClaimTx(tx, f.staff, claim.id, "")).rejects.toThrow("发票号");
      await expect(submitClaimTx(tx, f.staff, claim.id, "F".repeat(31))).rejects.toThrow("6～30 位"); // 超长不截断
      await submitClaimTx(tx, f.staff, claim.id, "FP2026102100");
      expect(await tx.subsidyClaim.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ status: "SUBMITTED", invoiceNo: "FP2026102100" });
      await expect(submitClaimTx(tx, f.staff, claim.id, "FP2026102100")).rejects.toThrow("待提交、被驳回");
      await tx.subsidyClaim.update({ where: { id: claim.id }, data: { status: "REJECTED", rejectReason: "发票抬头不对" } });
      await submitClaimTx(tx, f.manager, claim.id, "FP2026102101");
      expect(await tx.subsidyClaim.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ status: "SUBMITTED", invoiceNo: "FP2026102101", rejectReason: null });
    });
  });

  it("导入平台结果：按核销码落状态，状态不对的不处理，找不到的列出来；只有总部能导；模拟审核、到账", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setPolicy(tx);
      const codes: string[] = [];
      for (const seed of [31, 32, 33, 34]) {
        const { saleId } = await subsidizedSale(tx, seed);
        const claim = await tx.subsidyClaim.findFirstOrThrow({ where: { salesOrderId: saleId } });
        if (seed !== 34) await submitClaimTx(tx, f.staff, claim.id, `FP20261021${seed}`);
        codes.push(claim.qualificationCode);
      }
      const [a, b, c, pending] = codes as [string, string, string, string];
      await expect(importPlatformResults(f.manager, "核销码,结果\nX,通过", tx)).rejects.toThrow("只有总部");
      const csv = `核销码,结果,金额（元）,原因\n${a},通过,,\n${b},驳回,,串号照片看不清\n${c},已到账,300.00,\n${pending},已到账,,\nNOSUCHCODE01,通过,,`;
      const r = await importPlatformResults(f.hq, csv, tx);
      expect([r.applied, r.skipped.length, r.unmatched]).toEqual([3, 1, ["NOSUCHCODE01"]]);
      // 到账 300 元和补贴不一样：列出来
      expect(r.amountDiff.map((x) => x.settledFen)).toEqual([30000]);
      const byCode = async (code: string) => tx.subsidyClaim.findFirstOrThrow({ where: { qualificationCode: code } });
      expect((await byCode(a)).status).toBe("APPROVED");
      expect(await byCode(b)).toMatchObject({ status: "REJECTED", rejectReason: "串号照片看不清" });
      expect(await byCode(c)).toMatchObject({ status: "SETTLED", settledFen: 30000 });
      expect((await byCode(pending)).status).toBe("PENDING");

      // 模拟器：审核中的（这里没有了）不动；待到账的全部到账
      await simulateReview(f.hq, { db: tx, random: () => 0.5 });
      const settled = await simulateSettle(f.hq, { db: tx });
      expect(settled.applied).toBeGreaterThanOrEqual(1);
      expect(await byCode(a)).toMatchObject({ status: "SETTLED", settledFen: (await byCode(a)).subsidyFen });
      await expect(simulateSettle(f.staff, { db: tx })).rejects.toThrow("只有总部");
    });
  });
});
