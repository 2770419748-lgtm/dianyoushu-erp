import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { maskPhone } from "@/lib/sales-labels";
import { canSell, canVoidSales } from "@/server/auth/permissions";
import { assertStoreAccess, PermissionError, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { nextDocNo, todayBizDate } from "@/server/stock/doc-no";
import { canSell as deviceCanSell, DeviceStateError } from "@/server/stock/device-state";
import { applyDeviceAction, changeAccessoryStock, StockError } from "@/server/stock/stock-service";
import { effectivePriceFen } from "@/server/products/search";
import { buildSalePayments, PaymentError } from "./payments";
import { DAY_CLOSED_MESSAGE, isDayClosed } from "@/server/dailyclose/guard";

// 开单服务层：选机器和配件、改价优惠、以旧换新抵扣（关联回收单）、多种收款拆分（合计必须等于应收）。
// 口径第 11 节第 3 条：销售单、明细、收款、扣库存、写流水在一个事务里，失败全部回滚。
// *Tx 版本接收调用方的事务（测试里可以回滚），不带 Tx 的版本自己开事务。

export class SalesError extends Error {}

type Tx = Prisma.TransactionClient;

export interface SalesItemInput {
  deviceId?: unknown; // 大件：机器 id
  skuId?: unknown; // 小件：SKU id
  qty?: unknown; // 小件数量
  unitPriceFen?: unknown; // 不填按门店售价 / 指导价
}

export interface SalesOrderInput {
  storeId: unknown;
  customerId?: unknown;
  items: SalesItemInput[];
  discountFen?: unknown;
  tradeInOrderId?: unknown; // 以旧换新：关联一张本店未用过的回收单，估价全额抵扣
  payments?: { method: unknown; amountFen: unknown }[]; // 手工收款，可以拆多种
  paymentMethod?: unknown; // 兼容只收一种的写法：剩余金额全按这一种收
  note?: unknown;
}

function requireId(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new SalesError(`请选择${label}`);
  return n;
}

function optionalFen(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new SalesError(`${label}必须是不小于 0 的金额`);
  return n;
}

function parseOrder(input: SalesOrderInput) {
  const storeId = requireId(input.storeId, "门店");
  const customerId = input.customerId ? requireId(input.customerId, "客户") : null;
  if (!Array.isArray(input.items) || input.items.length === 0) throw new SalesError("至少要有一件商品");
  const deviceLines: { deviceId: number; unitPriceFen: number | null }[] = [];
  const accessoryLines: { skuId: number; qty: number; unitPriceFen: number | null }[] = [];
  input.items.forEach((item, index) => {
    const unitPriceFen = optionalFen(item.unitPriceFen, `第 ${index + 1} 行单价`);
    if (item.deviceId) {
      deviceLines.push({ deviceId: requireId(item.deviceId, "机器"), unitPriceFen });
    } else {
      const qty = Number(item.qty ?? 1);
      if (!Number.isInteger(qty) || qty <= 0) throw new SalesError(`第 ${index + 1} 行数量必须是正整数`);
      accessoryLines.push({ skuId: requireId(item.skuId, "配件"), qty, unitPriceFen });
    }
  });
  if (new Set(deviceLines.map((d) => d.deviceId)).size !== deviceLines.length) throw new SalesError("同一台机器选了两次");
  const discountFen = optionalFen(input.discountFen, "整单优惠") ?? 0;
  const tradeInOrderId = input.tradeInOrderId ? requireId(input.tradeInOrderId, "回收单") : null;
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) || null : null;
  return { storeId, customerId, deviceLines, accessoryLines, discountFen, tradeInOrderId, note };
}

async function resolveUnitPrice(tx: Tx, storeId: number, skuId: number, guidePriceFen: number): Promise<number> {
  const override = await tx.storePrice.findUnique({ where: { storeId_skuId: { storeId, skuId } } });
  return effectivePriceFen(guidePriceFen, override?.priceFen ?? null);
}

function wrapStockError(error: unknown): never {
  if (error instanceof StockError || error instanceof DeviceStateError) throw new SalesError(error.message);
  throw error;
}

// ---------- 开单 ----------

export async function createSalesOrderTx(tx: Tx, user: CurrentUser, input: SalesOrderInput) {
  if (!canSell(user.role)) throw new SalesError("你的角色不能开单");
  const data = parseOrder(input);
  const store = await tx.store.findUnique({ where: { id: data.storeId }, select: { id: true, regionId: true, isActive: true } });
  if (!store || !store.isActive) throw new SalesError("门店不存在或已停用");
  assertStoreAccess(user, store);
  if (await isDayClosed(tx, data.storeId, todayBizDate())) throw new SalesError(DAY_CLOSED_MESSAGE);
  if (data.customerId) {
    const customer = await tx.customer.findUnique({ where: { id: data.customerId }, select: { id: true } });
    if (!customer) throw new SalesError("客户不存在");
  }

  type Line = { skuId: number; deviceId: number | null; qty: number; unitPriceFen: number; lineTotalFen: number; costFen: number };
  const lines: Line[] = [];
  for (const d of data.deviceLines) {
    const device = await tx.device.findUnique({ where: { id: d.deviceId }, include: { sku: { select: { id: true, name: true, guidePriceFen: true } } } });
    if (!device) throw new SalesError("机器不存在");
    if (device.storeId !== data.storeId) throw new SalesError(`${device.code} 不在本店`);
    if (!deviceCanSell(device.status)) throw new SalesError(`${device.code} 现在不能卖`);
    const unitPriceFen = d.unitPriceFen ?? (await resolveUnitPrice(tx, data.storeId, device.skuId, device.sku.guidePriceFen));
    lines.push({ skuId: device.skuId, deviceId: device.id, qty: 1, unitPriceFen, lineTotalFen: unitPriceFen, costFen: device.costFen });
  }
  for (const a of data.accessoryLines) {
    const sku = await tx.sku.findUnique({ where: { id: a.skuId }, include: { model: { include: { category: true } } } });
    if (!sku || !sku.isActive) throw new SalesError("配件不存在或已停售");
    if (sku.model.category.kind !== "ACCESSORY") throw new SalesError(`${sku.name} 是大件，要按机器选`);
    const unitPriceFen = a.unitPriceFen ?? (await resolveUnitPrice(tx, data.storeId, sku.id, sku.guidePriceFen));
    lines.push({ skuId: sku.id, deviceId: null, qty: a.qty, unitPriceFen, lineTotalFen: unitPriceFen * a.qty, costFen: sku.costPriceFen * a.qty });
  }

  const subtotalFen = lines.reduce((s, l) => s + l.lineTotalFen, 0);
  if (data.discountFen > subtotalFen) throw new SalesError("优惠不能超过商品合计");
  const totalFen = subtotalFen - data.discountFen;

  // 以旧换新：回收单必须是本店、已完成、没被别的销售单用过；估价全额抵扣
  let tradeIn: { id: number; orderNo: string; appraisedFen: number; customerId: number | null } | null = null;
  if (data.tradeInOrderId) {
    const t = await tx.tradeInOrder.findUnique({ where: { id: data.tradeInOrderId }, include: { salesOrder: { select: { id: true } } } });
    if (!t || t.status !== "COMPLETED") throw new SalesError("回收单不存在或已作废");
    if (t.storeId !== data.storeId) throw new SalesError("回收单不是本店的");
    if (t.salesOrder) throw new SalesError(`回收单 ${t.orderNo} 已经抵扣过别的销售单`);
    tradeIn = { id: t.id, orderNo: t.orderNo, appraisedFen: t.appraisedFen, customerId: t.customerId };
  }

  // 收款：抵扣 + 手工收款，合计必须正好等于应收
  const manual = Array.isArray(input.payments)
    ? input.payments
    : input.paymentMethod
      ? [{ method: input.paymentMethod, amountFen: totalFen - (tradeIn?.appraisedFen ?? 0) }]
      : [];
  let payments;
  try {
    payments = buildSalePayments(totalFen, tradeIn?.appraisedFen ?? 0, manual);
  } catch (error) {
    if (error instanceof PaymentError) throw new SalesError(error.message);
    throw error;
  }

  const orderNo = await nextDocNo(tx, "SO");
  const order = await tx.salesOrder.create({
    data: {
      orderNo,
      storeId: data.storeId,
      customerId: data.customerId ?? tradeIn?.customerId ?? null,
      salespersonId: user.id,
      bizDate: todayBizDate(),
      subtotalFen,
      discountFen: data.discountFen,
      totalFen,
      note: data.note,
      tradeInOrderId: tradeIn?.id ?? null,
      items: { create: lines },
      payments: {
        create: payments.map((p) =>
          p.method === "TRADE_IN" && tradeIn ? { method: p.method, amountFen: p.amountFen, tradeInOrderId: tradeIn.id, reference: tradeIn.orderNo } : { method: p.method, amountFen: p.amountFen },
        ),
      },
    },
  });

  try {
    for (const line of lines) {
      if (line.deviceId) {
        await applyDeviceAction(tx, { deviceId: line.deviceId, action: "SELL", docType: "SALE", docNo: orderNo, operatorId: user.id });
      } else {
        await changeAccessoryStock(tx, { storeId: data.storeId, skuId: line.skuId, qtyDelta: -line.qty, docType: "SALE", docNo: orderNo, operatorId: user.id });
      }
    }
  } catch (error) {
    wrapStockError(error);
  }

  await writeAudit({ userId: user.id, action: "sale.create", entity: "sales_order", entityId: order.id, detail: { orderNo, totalFen, lines: lines.length, tradeIn: tradeIn?.orderNo ?? null, payments: payments.map((p) => p.method) } }, tx);
  return { id: order.id, orderNo };
}

export async function createSalesOrder(user: CurrentUser, input: SalesOrderInput) {
  return prisma.$transaction((tx) => createSalesOrderTx(tx, user, input));
}

// ---------- 作废 ----------

export async function voidSalesOrderTx(tx: Tx, user: CurrentUser, orderId: number, reason: unknown) {
  if (!canVoidSales(user.role)) throw new SalesError("只有店长和总部能作废销售单");
  const order = await tx.salesOrder.findUnique({ where: { id: orderId }, include: { store: true, items: true, _count: { select: { returnOrders: true } } } });
  if (!order) throw new SalesError("销售单不存在");
  assertStoreAccess(user, order.store);
  if (order.status !== "COMPLETED") throw new SalesError("这张单已经作废了");
  if (order.dailyCloseId) throw new SalesError("当日已日结确认，不能作废");
  if (order._count.returnOrders > 0) throw new SalesError("这张单已经有退货记录，不能作废，剩下的继续走退货");
  const voidReason = typeof reason === "string" ? reason.trim().slice(0, 200) || null : null;

  try {
    for (const item of order.items) {
      if (item.deviceId) {
        await applyDeviceAction(tx, { deviceId: item.deviceId, action: "VOID_SALE", docType: "SALE_VOID", docNo: order.orderNo, operatorId: user.id, note: voidReason ?? undefined });
      } else {
        await changeAccessoryStock(tx, { storeId: order.storeId, skuId: item.skuId, qtyDelta: item.qty, docType: "SALE_VOID", docNo: order.orderNo, operatorId: user.id, note: voidReason ?? undefined });
      }
    }
  } catch (error) {
    wrapStockError(error);
  }
  // 关联的回收单放回去：旧机还在店里，回收单可以抵扣下一张单（抵扣记录的 reference 里还留着回收单号）
  if (order.tradeInOrderId) {
    await tx.payment.updateMany({ where: { salesOrderId: orderId, tradeInOrderId: order.tradeInOrderId }, data: { tradeInOrderId: null } });
  }
  await tx.salesOrder.update({ where: { id: orderId }, data: { status: "VOIDED", voidedById: user.id, voidedAt: new Date(), voidReason, tradeInOrderId: null } });
  await writeAudit({ userId: user.id, action: "sale.void", entity: "sales_order", entityId: orderId, detail: { reason: voidReason } }, tx);
}

export async function voidSalesOrder(user: CurrentUser, orderId: number, reason: unknown) {
  return prisma.$transaction((tx) => voidSalesOrderTx(tx, user, orderId, reason));
}

// ---------- 查询 ----------

export const SALES_PAGE_SIZE = 20;

export async function listSalesOrders(user: CurrentUser, query: { storeId?: number; page?: number }) {
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  const where = {
    AND: [storeScopeWhere(user), user.role === "STAFF" ? { salespersonId: user.id } : {}, query.storeId ? { storeId: query.storeId } : {}],
  };
  const [rows, total] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * SALES_PAGE_SIZE,
      take: SALES_PAGE_SIZE,
      include: {
        store: { select: { code: true, name: true } },
        customer: { select: { name: true, phone: true } },
        salesperson: { select: { name: true } },
        payments: { select: { method: true, amountFen: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.salesOrder.count({ where }),
  ]);
  return {
    rows: rows.map((o) => ({ ...o, customer: o.customer ? { name: o.customer.name, phoneMasked: maskPhone(o.customer.phone) } : null })),
    total,
    page,
    pageSize: SALES_PAGE_SIZE,
  };
}

export type SalesOrderRow = Awaited<ReturnType<typeof listSalesOrders>>["rows"][number];

export async function getSalesOrder(user: CurrentUser, id: number) {
  const order = await prisma.salesOrder.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, code: true, name: true, regionId: true } },
      customer: { select: { id: true, name: true, phone: true } },
      salesperson: { select: { id: true, name: true } },
      voidedBy: { select: { name: true } },
      items: { include: { sku: { select: { name: true } }, device: { select: { code: true } } } },
      payments: { orderBy: { id: "asc" } },
      tradeInOrder: { select: { id: true, orderNo: true, modelName: true, deviceCode: true, appraisedFen: true } },
      returnOrders: {
        orderBy: { id: "asc" },
        include: { handledBy: { select: { name: true } }, payments: true, items: { include: { sku: { select: { name: true } }, device: { select: { code: true } } } } },
      },
    },
  });
  if (!order) return null;
  assertStoreAccess(user, order.store);
  // 店员只能看自己开的单
  if (user.role === "STAFF" && order.salespersonId !== user.id) throw new PermissionError("店员只能看自己开的单");
  return { ...order, customer: order.customer ? { id: order.customer.id, name: order.customer.name, phoneMasked: maskPhone(order.customer.phone) } : null };
}

export type SalesOrderDetail = NonNullable<Awaited<ReturnType<typeof getSalesOrder>>>;

/** 开单时可选的机器：本店在库或良品，按任意码或商品名搜 */
export async function searchSellableDevices(user: CurrentUser, storeId: number, q = "") {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true } });
  if (!store) throw new SalesError("门店不存在");
  assertStoreAccess(user, store);
  const text = q.trim();
  const devices = await prisma.device.findMany({
    where: {
      storeId,
      status: { in: ["IN_STOCK", "REFURBISHED"] },
      ...(text
        ? { OR: [{ code: { contains: text } }, { sn: { contains: text } }, { imei2: { contains: text } }, { sku: { name: { contains: text, mode: "insensitive" } } }] }
        : {}),
    },
    orderBy: [{ skuId: "asc" }, { code: "asc" }],
    take: 50,
    include: {
      sku: { select: { id: true, name: true, guidePriceFen: true, storePrices: { where: { storeId }, select: { priceFen: true } } } },
      tradeInOrder: { select: { modelName: true } },
    },
  });
  return devices.map((d) => ({
    id: d.id,
    code: d.code,
    status: d.status,
    skuId: d.sku.id,
    // 良品（回收机）显示回收单上写的真实机型
    skuName: d.status === "REFURBISHED" ? `良品 · ${d.tradeInOrder?.modelName ?? d.sku.name}` : d.sku.name,
    priceFen: effectivePriceFen(d.sku.guidePriceFen, d.sku.storePrices[0]?.priceFen ?? null),
  }));
}

export type SellableDevice = Awaited<ReturnType<typeof searchSellableDevices>>[number];

/** 开单时可选的配件：本店有数量的 */
export async function listSellableAccessories(user: CurrentUser, storeId: number) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true } });
  if (!store) throw new SalesError("门店不存在");
  assertStoreAccess(user, store);
  const stocks = await prisma.accessoryStock.findMany({
    where: { storeId, qty: { gt: 0 }, sku: { isActive: true } },
    orderBy: { sku: { name: "asc" } },
    include: { sku: { select: { id: true, name: true, guidePriceFen: true, storePrices: { where: { storeId }, select: { priceFen: true } } } } },
  });
  return stocks.map((s) => ({
    skuId: s.sku.id,
    name: s.sku.name,
    qty: s.qty,
    priceFen: effectivePriceFen(s.sku.guidePriceFen, s.sku.storePrices[0]?.priceFen ?? null),
  }));
}

export type SellableAccessory = Awaited<ReturnType<typeof listSellableAccessories>>[number];
