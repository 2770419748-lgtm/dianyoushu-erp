import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { cancelInvoiceTx, getInvoice, issueInvoiceTx, markDeliveredTx, redInvoiceTx, requestInvoiceTx } from "@/server/invoice/invoice-service";
import { createReturnTx } from "@/server/sales/return-service";
import { createSalesOrderTx, voidSalesOrderTx } from "@/server/sales/sales-service";
import { receiveDevices } from "@/server/stock/stock-service";
import { submitClaimTx } from "@/server/subsidy/subsidy-service";
import { simulateInvoiceNumber } from "@/lib/invoice";
import { todayBizDate, todayBizDateText } from "@/server/stock/doc-no";
import { runIntegrityChecks } from "../prisma/integrity-checks";

// 发票（口径第 16 节，连本机库，事务回滚不留数据）：申请、开具、撤回、红冲、纸质票到店；退货作废联动；国补带发票号；对账自检第 10 类。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
type U = { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean };
type Fixture = { storeId: number; phoneSkuId: number; phoneCategoryId: number; priceFen: number; hq: CurrentUser; staff: CurrentUser; manager: CurrentUser; regional: CurrentUser | null };
let fixture: Fixture | null = null;

const asUser = (u: U) => ({ ...u, store: null, region: null }) as CurrentUser;
const imei = (seed: number) => String(980000000000000 + seed).padStart(15, "0");
const person = { kind: "E_NORMAL", titleType: "PERSONAL", titleName: "发票测试" };

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

async function setSeller(tx: Prisma.TransactionClient) {
  const data = { name: "测试公司", taxNo: "91440300MA5TEXT018", addressPhone: "测试地址 0755-1", bankAccount: "测试银行 1" };
  await tx.invoiceSeller.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
}

/** 卖一台机器（可整单优惠）给一个新客户 */
async function sale(tx: Prisma.TransactionClient, seed: number, opts: { discountFen?: number; subsidy?: boolean } = {}) {
  const f = fixture!;
  const customer = await tx.customer.create({ data: { name: "发票测试", phone: `195${String(seed).padStart(8, "0")}` } });
  const [deviceId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.phoneSkuId, devices: [{ sn: null, imei1: imei(seed), imei2: null }], costFen: 100000, docType: "PURCHASE_RECEIPT", docNo: `RI-KP-${seed}`, operatorId: f.hq.id });
  const totalFen = f.priceFen - (opts.discountFen ?? 0);
  const subsidyFen = opts.subsidy ? Math.min(Math.round((totalFen * 1500) / 10000), 50000) : 0;
  const order = await createSalesOrderTx(tx, f.hq, {
    storeId: f.storeId,
    customerId: customer.id,
    items: [{ deviceId }],
    discountFen: opts.discountFen ?? 0,
    subsidy: opts.subsidy ? { qualificationCode: `TESTKP${String(seed).padStart(6, "0")}1` } : null,
    payments: [{ method: "CASH", amountFen: totalFen - subsidyFen }],
  });
  return { orderId: order.id, totalFen, customerId: customer.id };
}

describe("发票（连本机库，事务回滚）", () => {
  it("申请：金额 = 这张单分摊优惠后的成交额，以旧换新、国补不减；一单一张在办的；作废的单不能开；区域经理不能申请", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const { orderId, totalFen } = await sale(tx, 1, { discountFen: 5000 });
      if (f.regional) await expect(requestInvoiceTx(tx, f.regional, { salesOrderId: orderId, ...person })).rejects.toThrow("不能申请开票");
      const { id, requestNo } = await requestInvoiceTx(tx, f.staff, { salesOrderId: orderId, ...person });
      expect(requestNo).toMatch(/^KP\d{12}$/);
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      expect(invoice).toMatchObject({ status: "REQUESTED", amountFen: totalFen, titleName: "发票测试", requestedById: f.staff.id });
      expect(invoice.lines.map((l) => [l.amountFen, l.taxRateBp])).toEqual([[totalFen, 1300]]);
      expect(invoice.taxFen).toBe(Math.round((totalFen * 1300) / 11300));
      await expect(requestInvoiceTx(tx, f.staff, { salesOrderId: orderId, ...person })).rejects.toThrow("已经有在办的发票");

      // 用了国补的单：发票金额还是全额
      await tx.subsidyPolicy.upsert({ where: { categoryId: f.phoneCategoryId }, create: { categoryId: f.phoneCategoryId, rateBp: 1500, capFen: 50000, priceCapFen: 600000, startsOn: new Date("2020-01-01"), endsOn: new Date("2099-12-31") }, update: { isActive: true, startsOn: new Date("2020-01-01"), endsOn: new Date("2099-12-31") } });
      const subsidized = await sale(tx, 2, { subsidy: true });
      const r2 = await requestInvoiceTx(tx, f.staff, { salesOrderId: subsidized.orderId, ...person });
      expect((await tx.invoice.findUniqueOrThrow({ where: { id: r2.id } })).amountFen).toBe(subsidized.totalFen);

      const voided = await sale(tx, 3);
      await voidSalesOrderTx(tx, f.manager, voided.orderId, "开错单");
      await expect(requestInvoiceTx(tx, f.staff, { salesOrderId: voided.orderId, ...person })).rejects.toThrow("作废的单不能开票");
    });
  });

  it("开具要先有公司开票信息；只有总部能开；号码可以登记也可以模拟；号码不重复；撤回只对待开票", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await tx.invoiceSeller.deleteMany();
      const a = await sale(tx, 11);
      const { id } = await requestInvoiceTx(tx, f.staff, { salesOrderId: a.orderId, ...person });
      await expect(issueInvoiceTx(tx, f.manager, id)).rejects.toThrow("只有总部");
      await expect(issueInvoiceTx(tx, f.hq, id)).rejects.toThrow("公司开票信息");
      await setSeller(tx);
      await expect(issueInvoiceTx(tx, f.hq, id, { invoiceNumber: "12AB" })).rejects.toThrow("8～20 位数字");
      await issueInvoiceTx(tx, f.hq, id, { invoiceNumber: "2644 1020 0000 0099 0001" });
      const issued = await tx.invoice.findUniqueOrThrow({ where: { id } });
      expect(issued).toMatchObject({ status: "ISSUED", invoiceNumber: "26441020000000990001", issueSource: "MANUAL", issuedById: f.hq.id });
      expect(issued.sellerSnapshot).toMatchObject({ name: "测试公司" });
      await expect(cancelInvoiceTx(tx, f.staff, id, "")).rejects.toThrow("待开票的才能撤回");

      const b = await sale(tx, 12);
      const r = await requestInvoiceTx(tx, f.staff, { salesOrderId: b.orderId, ...person });
      await expect(issueInvoiceTx(tx, f.hq, r.id, { invoiceNumber: "26441020000000990001" })).rejects.toThrow("已经登记在");
      const sim = await issueInvoiceTx(tx, f.hq, r.id); // 演示里不填就模拟
      expect(sim.invoiceNumber).toMatch(/^\d{20}$/);

      const c = await sale(tx, 13);
      const r3 = await requestInvoiceTx(tx, f.manager, { salesOrderId: c.orderId, ...person });
      await expect(cancelInvoiceTx(tx, f.staff, r3.id, "")).rejects.toThrow("申请人、店长和总部");
      await cancelInvoiceTx(tx, f.manager, r3.id, "客户不要了");
      expect((await tx.invoice.findUniqueOrThrow({ where: { id: r3.id } })).status).toBe("CANCELLED");
      await expect(requestInvoiceTx(tx, f.staff, { salesOrderId: c.orderId, ...person })).resolves.toBeTruthy(); // 撤回之后可以再申请
    });
  });

  it("退货、作废：待开票的自动撤回，已开票的标需红冲；红冲之后按剩下的重新申请；纸质票到店", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setSeller(tx);
      // 已开票后作废 → 需红冲 → 红冲
      const v = await sale(tx, 21);
      const iv = await requestInvoiceTx(tx, f.staff, { salesOrderId: v.orderId, ...person });
      await issueInvoiceTx(tx, f.hq, iv.id);
      await voidSalesOrderTx(tx, f.manager, v.orderId, "开错单");
      expect((await tx.invoice.findUniqueOrThrow({ where: { id: iv.id } })).status).toBe("RED_PENDING");
      await expect(redInvoiceTx(tx, f.manager, iv.id, { reason: "作废" })).rejects.toThrow("只有总部");
      await redInvoiceTx(tx, f.hq, iv.id, { reason: "" }); // 需红冲的不写原因就用系统记的
      expect(await tx.invoice.findUniqueOrThrow({ where: { id: iv.id } })).toMatchObject({ status: "REDDED", redReason: "销售单作废，要红冲" });

      // 待开票时退货 → 自动撤回；退完了不能再申请
      const r = await sale(tx, 22);
      const ir = await requestInvoiceTx(tx, f.staff, { salesOrderId: r.orderId, ...person });
      const item = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: r.orderId } });
      await createReturnTx(tx, f.hq, { salesOrderId: r.orderId, lines: [{ salesItemId: item.id, qty: 1 }], refundFen: r.totalFen, refundMethod: "CASH" });
      expect((await tx.invoice.findUniqueOrThrow({ where: { id: ir.id } })).status).toBe("CANCELLED");
      await expect(requestInvoiceTx(tx, f.staff, { salesOrderId: r.orderId, ...person })).rejects.toThrow("没有可开票的金额");

      // 纸质票：开好之后店长点到店；店员不能点
      const p = await sale(tx, 23);
      const ip = await requestInvoiceTx(tx, f.staff, { salesOrderId: p.orderId, kind: "PAPER_NORMAL", titleType: "PERSONAL", titleName: "纸质测试" });
      await expect(markDeliveredTx(tx, f.manager, ip.id)).rejects.toThrow("开好还没到店");
      await issueInvoiceTx(tx, f.hq, ip.id);
      await expect(markDeliveredTx(tx, f.staff, ip.id)).rejects.toThrow("店长和总部");
      await markDeliveredTx(tx, f.manager, ip.id);
      expect((await tx.invoice.findUniqueOrThrow({ where: { id: ip.id } })).deliveredAt).not.toBeNull();

      const checks = await runIntegrityChecks(tx as unknown as PrismaClient);
      expect(checks.invoice).toBe(0);
    });
  });

  it("国补单提交审核不填发票号：自动用这张单已开票的号码；没开票的提示先开票", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setSeller(tx);
      await tx.subsidyPolicy.upsert({ where: { categoryId: f.phoneCategoryId }, create: { categoryId: f.phoneCategoryId, rateBp: 1500, capFen: 50000, priceCapFen: 600000, startsOn: new Date("2020-01-01"), endsOn: new Date("2099-12-31") }, update: { isActive: true, startsOn: new Date("2020-01-01"), endsOn: new Date("2099-12-31") } });
      const s = await sale(tx, 31, { subsidy: true });
      const claim = await tx.subsidyClaim.findFirstOrThrow({ where: { salesOrderId: s.orderId } });
      await expect(submitClaimTx(tx, f.staff, claim.id, "")).rejects.toThrow("还没开票");
      const iv = await requestInvoiceTx(tx, f.staff, { salesOrderId: s.orderId, ...person });
      const { invoiceNumber } = await issueInvoiceTx(tx, f.hq, iv.id);
      await submitClaimTx(tx, f.staff, claim.id, "");
      expect((await tx.subsidyClaim.findUniqueOrThrow({ where: { id: claim.id } })).invoiceNo).toBe(invoiceNumber);

      // 平台驳回后，这张票红冲、重新开了一张：重提不填号要换成新号，填旧号拒
      await tx.subsidyClaim.update({ where: { id: claim.id }, data: { status: "REJECTED", rejectReason: "发票抬头和顾客实名不一致" } });
      await redInvoiceTx(tx, f.hq, iv.id, { reason: "抬头开错" });
      const again = await requestInvoiceTx(tx, f.staff, { salesOrderId: s.orderId, ...person, titleName: "改好的抬头" });
      const reissued = await issueInvoiceTx(tx, f.hq, again.id);
      await expect(submitClaimTx(tx, f.staff, claim.id, invoiceNumber)).rejects.toThrow("已经红冲了");
      await expect(submitClaimTx(tx, f.staff, claim.id, `${invoiceNumber.slice(0, 4)}-${invoiceNumber.slice(4, 12)} ${invoiceNumber.slice(12)}`)).rejects.toThrow("已经红冲了"); // 带横杠空格也认得出
      await submitClaimTx(tx, f.staff, claim.id, "");
      expect((await tx.subsidyClaim.findUniqueOrThrow({ where: { id: claim.id } })).invoiceNo).toBe(reissued.invoiceNumber);
    });
  });

  it("红字号码不能重复、不能和别的发票号撞：服务层拒，数据库唯一索引兜底，自检查得出来", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setSeller(tx);
      const ids: number[] = [];
      for (const seed of [41, 42, 43]) {
        const s = await sale(tx, seed);
        const r = await requestInvoiceTx(tx, f.staff, { salesOrderId: s.orderId, ...person });
        await issueInvoiceTx(tx, f.hq, r.id);
        ids.push(r.id);
      }
      await redInvoiceTx(tx, f.hq, ids[0]!, { redNumber: "26441020000000770001", reason: "测试" });
      await expect(redInvoiceTx(tx, f.hq, ids[1]!, { redNumber: "26441020000000770001", reason: "测试" })).rejects.toThrow("已经登记在");
      const third = await tx.invoice.findUniqueOrThrow({ where: { id: ids[2]! } });
      await expect(redInvoiceTx(tx, f.hq, ids[1]!, { redNumber: third.invoiceNumber!, reason: "测试" })).rejects.toThrow("已经登记在");

      await tx.$executeRaw`SAVEPOINT dup`;
      await expect(tx.invoice.update({ where: { id: ids[1]! }, data: { status: "REDDED", redNumber: "26441020000000770001", redAt: new Date() } })).rejects.toMatchObject({ code: "P2002" });
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT dup`;

      expect((await runIntegrityChecks(tx as unknown as PrismaClient)).invoice).toBe(0);
      await tx.invoice.update({ where: { id: ids[1]! }, data: { status: "REDDED", redNumber: third.invoiceNumber, redAt: new Date() } }); // 绕过服务层写成别人的发票号
      expect((await runIntegrityChecks(tx as unknown as PrismaClient)).invoice).toBe(1);
    });
  });

  it("别店的发票：详情抛 PermissionError（页面显示无权限页，不是出错页）", async (ctx) => {
    if (!fixture) return ctx.skip();
    const other = await prisma.invoice.findFirst({ where: { storeId: { not: fixture.storeId } }, select: { id: true } });
    if (!other) return ctx.skip();
    await expect(getInvoice(fixture.staff, other.id)).rejects.toBeInstanceOf(PermissionError);
    await expect(getInvoice(fixture.hq, other.id)).resolves.toBeTruthy();
  });
  it("模拟开具：下一张模拟号码恰好被手工登记过，就跳过它", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await setSeller(tx);
      const key = `FPNUM${todayBizDateText()}`;
      const current = (await tx.docCounter.findUnique({ where: { key } }))?.value ?? 0;
      const next = simulateInvoiceNumber(current + 1, todayBizDate());
      const a = await sale(tx, 61);
      const ra = await requestInvoiceTx(tx, f.staff, { salesOrderId: a.orderId, ...person });
      await issueInvoiceTx(tx, f.hq, ra.id, { invoiceNumber: next });
      const b = await sale(tx, 62);
      const rb = await requestInvoiceTx(tx, f.staff, { salesOrderId: b.orderId, ...person });
      const issued = await issueInvoiceTx(tx, f.hq, rb.id);
      expect(issued.invoiceNumber).not.toBe(next);
      expect(issued.invoiceNumber).toMatch(/^\d{20}$/);
    });
  });
});
