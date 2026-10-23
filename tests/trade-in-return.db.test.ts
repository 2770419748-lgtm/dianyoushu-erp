import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { createReturnTx, ReturnError } from "@/server/sales/return-service";
import { createSalesOrderTx, SalesError, voidSalesOrderTx } from "@/server/sales/sales-service";
import { changeAccessoryStock, receiveDevices } from "@/server/stock/stock-service";
import { createTradeInTx, GENERIC_TRADE_IN_SKU_NAME, refurbishTx, revealSellerId, TradeInError } from "@/server/tradein/trade-in-service";

// 回收登记卖家身份（口径第 20 节）：GB 11643 里的示例号码，校验位是对的
const SELLER = { sellerName: "回收测试卖家", sellerIdNo: "11010519491231002X" };

// 第 7 周核心链路（连本机库，事务回滚不留数据）：
// 回收单 → 旧机"回收"、成本 = 估价；开单关联回收单抵扣 + 两种支付；退货恢复库存、退款只退实付；
// 回收机转良品后能再卖。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let dbReady = false;
let fixture: { storeId: number; deviceSkuId: number; accessorySkuId: number; user: CurrentUser } | null = null;

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

const imei = (seed: number) => String(930000000000000 + seed).padStart(15, "0");

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [store, deviceSku, accessorySku, hq] = await Promise.all([
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, guidePriceFen: { gt: 0 }, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    if (store && deviceSku && accessorySku && hq) {
      fixture = {
        storeId: store.id,
        deviceSkuId: deviceSku.id,
        accessorySkuId: accessorySku.id,
        user: { id: hq.id, username: hq.username, name: hq.name, role: hq.role, storeId: hq.storeId, regionId: hq.regionId, mustChangePassword: false, isActive: hq.isActive, store: null, region: null },
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

describe("以旧换新、多支付、退货、转良品（连本机库，事务回滚）", () => {
  it("回收 → 抵扣开单（两种支付）→ 退货 → 转良品再卖", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      // 1. 回收单：旧机进回收，成本 = 估价
      const tradeIn = await createTradeInTx(tx, f.user, { ...SELLER,
        storeId: f.storeId,
        codesText: `SNOLD12345 ${imei(1)}`,
        skuId: f.deviceSkuId,
        condition: "9 成新",
        appraisedFen: 120000,
      });
      const oldDevice = await tx.device.findFirstOrThrow({ where: { tradeInOrderId: tradeIn.id } });
      expect(oldDevice.status).toBe("RECYCLED");
      expect(oldDevice.costFen).toBe(120000);
      expect(oldDevice.sn).toBe("SNOLD12345");
      expect((await tx.stockLedger.findFirstOrThrow({ where: { docNo: tradeIn.orderNo } })).qtyDelta).toBe(1);

      // 回收机还没转良品，不能卖
      await expect(createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ deviceId: oldDevice.id, unitPriceFen: 150000 }], paymentMethod: "CASH" })).rejects.toThrow(SalesError);

      // 2. 开单：新机 4999 + 配件 1 件 29，应收 5028；抵扣 1200，微信 3000，现金 828
      const [newDeviceId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: imei(2), imei2: null }], costFen: 400000, docType: "PURCHASE_RECEIPT", docNo: "RI-W7-1", operatorId: f.user.id });
      await changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: 3, docType: "PURCHASE_RECEIPT", docNo: "RI-W7-1", operatorId: f.user.id });

      // 合计对不上被拒
      await expect(
        createSalesOrderTx(tx, f.user, {
          storeId: f.storeId,
          items: [{ deviceId: newDeviceId, unitPriceFen: 499900 }],
          tradeInOrderId: tradeIn.id,
          payments: [{ method: "WECHAT", amountFen: 100 }],
        }),
      ).rejects.toThrow(/还差/);

      const sale = await createSalesOrderTx(tx, f.user, {
        storeId: f.storeId,
        items: [
          { deviceId: newDeviceId, unitPriceFen: 499900 },
          { skuId: f.accessorySkuId, qty: 1, unitPriceFen: 2900 },
        ],
        tradeInOrderId: tradeIn.id,
        payments: [
          { method: "WECHAT", amountFen: 300000 },
          { method: "CASH", amountFen: 82800 },
        ],
      });
      const saved = await tx.salesOrder.findUniqueOrThrow({ where: { id: sale.id }, include: { payments: { orderBy: { id: "asc" } } } });
      expect(saved.totalFen).toBe(502800);
      expect(saved.tradeInOrderId).toBe(tradeIn.id);
      expect(saved.payments.map((p) => [p.method, p.amountFen])).toEqual([
        ["TRADE_IN", 120000],
        ["WECHAT", 300000],
        ["CASH", 82800],
      ]);
      expect(saved.payments.reduce((s, p) => s + p.amountFen, 0)).toBe(saved.totalFen);

      // 同一张回收单不能再抵扣第二张单
      await expect(
        createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ skuId: f.accessorySkuId, qty: 1, unitPriceFen: 200000 }], tradeInOrderId: tradeIn.id, payments: [{ method: "CASH", amountFen: 80000 }] }),
      ).rejects.toThrow(/已经抵扣过/);

      // 3. 退货：退新机，最多只能退实付 3828，不能退抵扣
      const machineItem = (await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: sale.id, deviceId: newDeviceId } }))!;
      await expect(
        createReturnTx(tx, f.user, { salesOrderId: sale.id, lines: [{ salesItemId: machineItem.id, qty: 1 }], refundFen: 400000, refundMethod: "WECHAT" }),
      ).rejects.toThrow(ReturnError);
      // 退款方式必须是原单用过的
      await expect(
        createReturnTx(tx, f.user, { salesOrderId: sale.id, lines: [{ salesItemId: machineItem.id, qty: 1 }], refundFen: 100, refundMethod: "ALIPAY" }),
      ).rejects.toThrow(/原单用过/);

      const ret = await createReturnTx(tx, f.user, { salesOrderId: sale.id, lines: [{ salesItemId: machineItem.id, qty: 1 }], refundFen: 300000, refundMethod: "WECHAT", reason: "屏幕有问题" });
      expect((await tx.device.findUniqueOrThrow({ where: { id: newDeviceId! } })).status).toBe("IN_STOCK");
      const returnPayment = await tx.payment.findFirstOrThrow({ where: { returnOrderId: ret.id } });
      expect(returnPayment.method).toBe("WECHAT");
      expect(returnPayment.amountFen).toBe(-300000);
      const retLedger = await tx.stockLedger.findFirstOrThrow({ where: { docNo: ret.orderNo } });
      expect(retLedger.qtyDelta).toBe(1);
      expect(retLedger.statusAfter).toBe("IN_STOCK");
      // 同一行不能再退
      await expect(createReturnTx(tx, f.user, { salesOrderId: sale.id, lines: [{ salesItemId: machineItem.id, qty: 1 }], refundFen: 0, refundMethod: "WECHAT" })).rejects.toThrow(/最多还能退 0/);
      // 有退货的单不能作废
      await expect(voidSalesOrderTx(tx, f.user, sale.id, "")).rejects.toThrow(/退货/);

      // 4. 回收机转良品，再卖出去
      await refurbishTx(tx, f.user, oldDevice.id);
      expect((await tx.device.findUniqueOrThrow({ where: { id: oldDevice.id } })).status).toBe("REFURBISHED");
      await expect(refurbishTx(tx, f.user, oldDevice.id)).rejects.toThrow(TradeInError);
      const resale = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ deviceId: oldDevice.id, unitPriceFen: 150000 }], payments: [{ method: "ALIPAY", amountFen: 150000 }] });
      const resaleItem = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: resale.id } });
      expect(resaleItem.costFen).toBe(120000); // 良品毛利 = 售价 − 估价
      expect((await tx.device.findUniqueOrThrow({ where: { id: oldDevice.id } })).status).toBe("SOLD");

      // 良品退货回到良品
      await createReturnTx(tx, f.user, { salesOrderId: resale.id, lines: [{ salesItemId: resaleItem.id, qty: 1 }], refundFen: 150000, refundMethod: "ALIPAY" });
      expect((await tx.device.findUniqueOrThrow({ where: { id: oldDevice.id } })).status).toBe("REFURBISHED");
    });
  });

  it("作废带以旧换新的单：回收单放回去，可以抵扣下一单", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const tradeIn = await createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(10), skuId: f.deviceSkuId, condition: "8 成新", appraisedFen: 50000 });
      await changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: 2, docType: "PURCHASE_RECEIPT", docNo: "RI-W7-2", operatorId: f.user.id });
      const s1 = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ skuId: f.accessorySkuId, qty: 1, unitPriceFen: 60000 }], tradeInOrderId: tradeIn.id, payments: [{ method: "CASH", amountFen: 10000 }] });
      await voidSalesOrderTx(tx, f.user, s1.id, "录错了");
      const s2 = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ skuId: f.accessorySkuId, qty: 1, unitPriceFen: 60000 }], tradeInOrderId: tradeIn.id, payments: [{ method: "CASH", amountFen: 10000 }] });
      expect((await tx.salesOrder.findUniqueOrThrow({ where: { id: s2.id } })).tradeInOrderId).toBe(tradeIn.id);
      // 作废单的抵扣记录还留着回收单号
      const oldTradeInPayment = await tx.payment.findFirstOrThrow({ where: { salesOrderId: s1.id, method: "TRADE_IN" } });
      expect(oldTradeInPayment.reference).toBe(tradeIn.orderNo);
    });
  });

  it("回收单校验：码重复、没选机型、估价为 0 都拒绝", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(20), skuId: f.deviceSkuId, condition: "全新", appraisedFen: 1000 });
      await expect(createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(20), skuId: f.deviceSkuId, condition: "全新", appraisedFen: 1000 })).rejects.toThrow(TradeInError);
      await expect(createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(21), skuId: 0, condition: "全新", appraisedFen: 1000 })).rejects.toThrow(/机型/);
      await expect(createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(22), skuId: f.deviceSkuId, condition: "全新", appraisedFen: 0 })).rejects.toThrow(/估价/);
    });
  });

  it("回收登记卖家身份：姓名、身份证号必填，号码校验；库里存密文和打码号码，只有店长及以上能看全号且记日志（口径第 20 节）", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const input = { storeId: f.storeId, codesText: imei(23), skuId: f.deviceSkuId, condition: "全新", appraisedFen: 1000 };
      await expect(createTradeInTx(tx, f.user, input)).rejects.toThrow("卖家姓名");
      await expect(createTradeInTx(tx, f.user, { ...input, sellerName: "张三" })).rejects.toThrow("身份证号");
      await expect(createTradeInTx(tx, f.user, { ...input, sellerName: "张三", sellerIdNo: "110105194912310021" })).rejects.toThrow("校验码"); // 最后一位错了
      await expect(createTradeInTx(tx, f.user, { ...input, sellerName: "张三", sellerIdNo: "110105194902300020" })).rejects.toThrow("校验码"); // 校验位对、但 2 月 30 日不是真日期
      const t = await createTradeInTx(tx, f.user, { ...input, sellerName: " 张三 ", sellerIdNo: "11010519491231002x" }); // 小写 x、前后空格照样认
      const row = await tx.tradeInOrder.findUniqueOrThrow({ where: { id: t.id } });
      expect(row).toMatchObject({ sellerName: "张三", sellerIdMasked: "110***********002X" });
      expect(row.sellerIdEnc).toMatch(/^v1\./);
      expect(JSON.stringify(row)).not.toContain("11010519491231002X"); // 库里没有完整号码
      await expect(revealSellerId({ ...f.user, role: "STAFF" }, t.id, tx)).rejects.toThrow("店员只能看打码");
      expect(await revealSellerId(f.user, t.id, tx)).toBe("11010519491231002X");
      expect(await tx.auditLog.count({ where: { action: "trade_in.reveal_id", entityId: String(t.id) } })).toBe(1);
    });
  });

  it("本店卖出去的手机被拿回来以旧换新：沿用原来那台机器改成回收，在库的仍然拒绝（2026-10-18 深审）", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const generic = await tx.sku.findFirstOrThrow({ where: { name: GENERIC_TRADE_IN_SKU_NAME } });
      const [soldId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: imei(30), imei2: null }], costFen: 400000, docType: "PURCHASE_RECEIPT", docNo: "RI-RETAKE", operatorId: f.user.id });
      const sale = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ deviceId: soldId!, unitPriceFen: 500000 }], paymentMethod: "CASH" });
      const saleItem = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: sale.id } });

      // 店员选了“其他机型”也没关系：系统知道这台是什么机型，以系统为准
      const t = await createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(30), skuId: generic.id, modelName: "随便写的", condition: "9 成新", appraisedFen: 209000 });
      const device = await tx.device.findUniqueOrThrow({ where: { id: soldId! } });
      expect(device.status).toBe("RECYCLED");
      expect(device.skuId).toBe(f.deviceSkuId);
      expect(device.costFen).toBe(209000);
      expect(device.tradeInOrderId).toBe(t.id);
      expect(t.deviceCode).toBe(device.code);
      expect(await tx.device.count({ where: { imei1: imei(30) } })).toBe(1);
      const ledger = await tx.stockLedger.findFirstOrThrow({ where: { docNo: t.orderNo } });
      expect([ledger.qtyDelta, ledger.statusBefore, ledger.statusAfter, ledger.docType]).toEqual([1, "SOLD", "RECYCLED", "TRADE_IN"]);
      // 原销售单的成本快照不变；客户已经把机器换掉了，原单不能再退这台
      expect((await tx.salesOrderItem.findUniqueOrThrow({ where: { id: saleItem.id } })).costFen).toBe(400000);
      await expect(createReturnTx(tx, f.user, { salesOrderId: sale.id, lines: [{ salesItemId: saleItem.id, qty: 1 }], refundFen: 0, refundMethod: "CASH" })).rejects.toThrow(ReturnError);

      // 转良品后开单默认价：这台的 SKU 有指导价，按指导价
      await refurbishTx(tx, f.user, soldId!);
      expect((await tx.device.findUniqueOrThrow({ where: { id: soldId! } })).status).toBe("REFURBISHED");

      // 在库的机器、已经在回收库里的机器都不能再回收
      const [inStockId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: imei(31), imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-RETAKE2", operatorId: f.user.id });
      expect(inStockId).toBeGreaterThan(0);
      await expect(createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(31), skuId: f.deviceSkuId, condition: "全新", appraisedFen: 1000 })).rejects.toThrow(/在库/);
      await expect(createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(30), skuId: f.deviceSkuId, condition: "全新", appraisedFen: 1000 })).rejects.toThrow(/良品/);
      // 两个码分属两台机器
      await expect(createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: `${imei(30)} ${imei(31)}`, skuId: f.deviceSkuId, condition: "全新", appraisedFen: 1000 })).rejects.toThrow(/2 台/);
    });
  });

  it("用“其他机型”收的回收机转良品后，开单默认价取估价，不是 0（2026-10-18 深审）", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      const generic = await tx.sku.findFirstOrThrow({ where: { name: GENERIC_TRADE_IN_SKU_NAME } });
      expect(generic.guidePriceFen).toBe(0);
      const t = await createTradeInTx(tx, f.user, { ...SELLER, storeId: f.storeId, codesText: imei(40), skuId: generic.id, modelName: "某品牌 X1", condition: "9 成新", appraisedFen: 209000 });
      const device = await tx.device.findUniqueOrThrow({ where: { tradeInOrderId: t.id } });
      await refurbishTx(tx, f.user, device.id);
      const sale = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, items: [{ deviceId: device.id }], paymentMethod: "CASH" });
      const item = await tx.salesOrderItem.findFirstOrThrow({ where: { orderId: sale.id } });
      expect(item.unitPriceFen).toBe(209000);
      expect(item.listPriceFen).toBe(209000);
    });
  });

  it("数量、单价、合计超上限直接提示“数量不对 / 金额不对”，不再报笼统的操作失败（2026-10-18 深审）", async (ctx) => {
    if (!dbReady || !fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await changeAccessoryStock(tx, { storeId: f.storeId, skuId: f.accessorySkuId, qtyDelta: 9999, docType: "PURCHASE_RECEIPT", docNo: "RI-LIMIT", operatorId: f.user.id });
      const [deviceId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: imei(50), imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-LIMIT", operatorId: f.user.id });
      const sell = (items: { skuId?: number; deviceId?: number; qty?: number; unitPriceFen?: number }[], discountFen?: number) =>
        createSalesOrderTx(tx, f.user, { storeId: f.storeId, items, discountFen, paymentMethod: "CASH" });
      await expect(sell([{ skuId: f.accessorySkuId, qty: 1e9 }])).rejects.toThrow(/数量不对/);
      await expect(sell([{ skuId: f.accessorySkuId, qty: 99999 }])).rejects.toThrow(/数量不对/);
      await expect(sell([{ deviceId: deviceId!, unitPriceFen: 1e12 }])).rejects.toThrow(/金额不对/);
      await expect(sell([{ skuId: f.accessorySkuId, qty: 1, unitPriceFen: 2_100_000_000 }])).rejects.toThrow(/金额不对/);
      await expect(sell([{ skuId: f.accessorySkuId, qty: 1, unitPriceFen: 100 }], 2e12)).rejects.toThrow(/金额不对/);
      // 每样都没超，乘起来超了
      await expect(sell([{ skuId: f.accessorySkuId, qty: 9999, unitPriceFen: 999_999_00 }])).rejects.toThrow(/合计/);
    });
  });
});
