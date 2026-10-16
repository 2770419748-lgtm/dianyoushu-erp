import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canManagePurchase } from "@/server/auth/permissions";
import { assertStoreAccess, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { nextDocNo } from "@/server/stock/doc-no";
import { parseImeiList } from "@/server/stock/imei";
import { changeAccessoryStock, receiveDevices, StockError } from "@/server/stock/stock-service";

// 采购入库服务层：采购单（草稿 → 已提交 → 已到货，可作废）和到货入库。
// 入库的库存变动全部交给 src/server/stock/stock-service.ts，并和入库单放在同一个事务里。

export class PurchaseError extends Error {}

type Actor = Pick<CurrentUser, "id" | "role">;

function assertCanManage(actor: Actor): void {
  if (!canManagePurchase(actor.role)) throw new PurchaseError("只有总部账号能做采购");
}

function requireId(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new PurchaseError(`请选择${label}`);
  return n;
}

function optionalText(value: unknown, max = 200): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new PurchaseError(`最多 ${max} 个字`);
  return text || null;
}

export interface PurchaseItemInput {
  skuId: unknown;
  qty: unknown;
  unitCostFen: unknown;
}

export interface PurchaseOrderInput {
  storeId: unknown;
  supplierName?: unknown;
  note?: unknown;
  items: PurchaseItemInput[];
}

function parseOrder(input: PurchaseOrderInput) {
  const storeId = requireId(input.storeId, "收货门店");
  if (!Array.isArray(input.items) || input.items.length === 0) throw new PurchaseError("至少要有一行商品");
  const items = input.items.map((item, index) => {
    const skuId = requireId(item.skuId, `第 ${index + 1} 行的商品`);
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new PurchaseError(`第 ${index + 1} 行数量必须是正整数`);
    const unitCostFen = Number(item.unitCostFen);
    if (!Number.isInteger(unitCostFen) || unitCostFen < 0) throw new PurchaseError(`第 ${index + 1} 行成本单价不对`);
    return { skuId, qty, unitCostFen };
  });
  const skuIds = new Set(items.map((i) => i.skuId));
  if (skuIds.size !== items.length) throw new PurchaseError("同一个商品不要重复开行，把数量合并");
  return { storeId, supplierName: optionalText(input.supplierName, 60), note: optionalText(input.note), items };
}

// ---------- 查询 ----------

export const PURCHASE_PAGE_SIZE = 20;

export async function listPurchaseOrders(user: CurrentUser, page = 1) {
  const current = Math.max(1, Math.floor(page) || 1);
  const where = storeScopeWhere(user);
  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (current - 1) * PURCHASE_PAGE_SIZE,
      take: PURCHASE_PAGE_SIZE,
      include: {
        store: { select: { code: true, name: true } },
        createdBy: { select: { name: true } },
        items: { select: { qty: true, receivedQty: true, unitCostFen: true } },
      },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return { rows, total, page: current, pageSize: PURCHASE_PAGE_SIZE };
}

export type PurchaseOrderRow = Awaited<ReturnType<typeof listPurchaseOrders>>["rows"][number];

export async function getPurchaseOrder(user: CurrentUser, id: number) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, code: true, name: true, regionId: true } },
      createdBy: { select: { name: true } },
      items: {
        orderBy: { id: "asc" },
        include: { sku: { include: { model: { include: { brand: true, category: true } } } } },
      },
      receipts: {
        orderBy: { id: "asc" },
        include: {
          receivedBy: { select: { name: true } },
          items: { include: { sku: { select: { name: true } } } },
          devices: { select: { imei: true, skuId: true } },
        },
      },
    },
  });
  if (!order) return null;
  assertStoreAccess(user, { id: order.store.id, regionId: order.store.regionId });
  return order;
}

export type PurchaseOrderDetail = NonNullable<Awaited<ReturnType<typeof getPurchaseOrder>>>;

/** 新建采购单时要选的商品：在售 SKU（带品类大件/小件） */
export async function listSkuOptions() {
  return prisma.sku.findMany({
    where: { isActive: true },
    orderBy: [{ model: { brand: { name: "asc" } } }, { model: { name: "asc" } }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      costPriceFen: true,
      model: { select: { name: true, brand: { select: { name: true } }, category: { select: { kind: true } } } },
    },
  });
}

export type SkuOption = Awaited<ReturnType<typeof listSkuOptions>>[number];

// ---------- 采购单 ----------

export async function createPurchaseOrder(actor: Actor, input: PurchaseOrderInput) {
  assertCanManage(actor);
  const data = parseOrder(input);
  const order = await prisma.$transaction(async (tx) => {
    const orderNo = await nextDocNo(tx, "PO");
    return tx.purchaseOrder.create({
      data: {
        orderNo,
        storeId: data.storeId,
        supplierName: data.supplierName,
        note: data.note,
        createdById: actor.id,
        items: { create: data.items },
      },
    });
  });
  await writeAudit({ userId: actor.id, action: "purchase.create", entity: "purchase_order", entityId: order.id, detail: { orderNo: order.orderNo, items: data.items.length } });
  return order;
}

export async function updatePurchaseOrder(actor: Actor, id: number, input: PurchaseOrderInput) {
  assertCanManage(actor);
  const data = parseOrder(input);
  const order = await prisma.purchaseOrder.findUnique({ where: { id }, select: { status: true } });
  if (!order) throw new PurchaseError("采购单不存在");
  if (order.status !== "DRAFT") throw new PurchaseError("只有草稿能改");
  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrderItem.deleteMany({ where: { orderId: id } });
    await tx.purchaseOrder.update({
      where: { id },
      data: { storeId: data.storeId, supplierName: data.supplierName, note: data.note, items: { create: data.items } },
    });
  });
  await writeAudit({ userId: actor.id, action: "purchase.update", entity: "purchase_order", entityId: id, detail: { items: data.items.length } });
}

export async function submitPurchaseOrder(actor: Actor, id: number) {
  assertCanManage(actor);
  const order = await prisma.purchaseOrder.findUnique({ where: { id }, include: { _count: { select: { items: true } } } });
  if (!order) throw new PurchaseError("采购单不存在");
  if (order.status !== "DRAFT") throw new PurchaseError("只有草稿能提交");
  if (order._count.items === 0) throw new PurchaseError("没有商品行，不能提交");
  await prisma.purchaseOrder.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
  await writeAudit({ userId: actor.id, action: "purchase.submit", entity: "purchase_order", entityId: id });
}

export async function voidPurchaseOrder(actor: Actor, id: number, reason: unknown) {
  assertCanManage(actor);
  const order = await prisma.purchaseOrder.findUnique({ where: { id }, include: { _count: { select: { receipts: true } } } });
  if (!order) throw new PurchaseError("采购单不存在");
  if (order.status !== "DRAFT" && order.status !== "SUBMITTED") throw new PurchaseError("只有草稿或已提交的单能作废");
  if (order._count.receipts > 0) throw new PurchaseError("已经有到货记录，不能作废");
  const note = optionalText(reason);
  await prisma.purchaseOrder.update({
    where: { id },
    data: { status: "VOIDED", voidedAt: new Date(), note: note ? `${order.note ? `${order.note}；` : ""}作废原因：${note}` : order.note },
  });
  await writeAudit({ userId: actor.id, action: "purchase.void", entity: "purchase_order", entityId: id, detail: { reason: note } });
}

// ---------- 到货入库 ----------

export interface ReceiveLineInput {
  itemId: unknown;
  imeiText?: unknown; // 大件：粘贴的串号
  qty?: unknown; // 小件：数量
}

export interface ReceiveGoodsInput {
  purchaseOrderId: unknown;
  lines: ReceiveLineInput[];
  note?: unknown;
}

export async function receiveGoods(actor: Actor, input: ReceiveGoodsInput) {
  assertCanManage(actor);
  const orderId = requireId(input.purchaseOrderId, "采购单");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new PurchaseError("没有要入库的内容");
  const note = optionalText(input.note);

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: { include: { sku: { include: { model: { include: { category: true } } } } } } },
  });
  if (!order) throw new PurchaseError("采购单不存在");
  if (order.status !== "SUBMITTED") throw new PurchaseError("只有已提交的采购单能到货入库");

  // 先把每一行校验好，再进事务
  const plans: { item: (typeof order.items)[number]; imeis: string[]; qty: number }[] = [];
  for (const line of input.lines) {
    const itemId = requireId(line.itemId, "采购明细");
    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new PurchaseError("采购明细不属于这张单");
    const remaining = item.qty - item.receivedQty;
    if (remaining <= 0) continue;

    if (item.sku.model.category.kind === "DEVICE") {
      const parsed = parseImeiList(typeof line.imeiText === "string" ? line.imeiText : "");
      if (parsed.valid.length === 0) continue;
      if (parsed.invalid.length > 0) throw new PurchaseError(`${item.sku.name}：有不是 15 位数字的串号：${parsed.invalid.slice(0, 3).join("、")}`);
      if (parsed.duplicates.length > 0) throw new PurchaseError(`${item.sku.name}：粘贴的串号里有重复：${parsed.duplicates.slice(0, 3).join("、")}`);
      if (parsed.valid.length > remaining) throw new PurchaseError(`${item.sku.name}：还差 ${remaining} 台，但录了 ${parsed.valid.length} 个串号`);
      plans.push({ item, imeis: parsed.valid, qty: parsed.valid.length });
    } else {
      const qty = Number(line.qty ?? 0);
      if (qty === 0) continue;
      if (!Number.isInteger(qty) || qty < 0) throw new PurchaseError(`${item.sku.name}：数量必须是正整数`);
      if (qty > remaining) throw new PurchaseError(`${item.sku.name}：还差 ${remaining} 件，但录了 ${qty} 件`);
      plans.push({ item, imeis: [], qty });
    }
  }
  if (plans.length === 0) throw new PurchaseError("没有填任何串号或数量");

  try {
    const receipt = await prisma.$transaction(async (tx) => {
      const receiptNo = await nextDocNo(tx, "RI");
      const created = await tx.goodsReceipt.create({
        data: { receiptNo, purchaseOrderId: order.id, storeId: order.storeId, receivedById: actor.id, note },
      });
      for (const plan of plans) {
        await tx.goodsReceiptItem.create({
          data: { receiptId: created.id, skuId: plan.item.skuId, qty: plan.qty, unitCostFen: plan.item.unitCostFen },
        });
        if (plan.imeis.length > 0) {
          await receiveDevices(tx, {
            storeId: order.storeId,
            skuId: plan.item.skuId,
            imeis: plan.imeis,
            costFen: plan.item.unitCostFen,
            docType: "PURCHASE_RECEIPT",
            docNo: receiptNo,
            operatorId: actor.id,
            goodsReceiptId: created.id,
          });
        } else {
          await changeAccessoryStock(tx, {
            storeId: order.storeId,
            skuId: plan.item.skuId,
            qtyDelta: plan.qty,
            docType: "PURCHASE_RECEIPT",
            docNo: receiptNo,
            operatorId: actor.id,
          });
        }
        await tx.purchaseOrderItem.update({ where: { id: plan.item.id }, data: { receivedQty: { increment: plan.qty } } });
      }
      const items = await tx.purchaseOrderItem.findMany({ where: { orderId: order.id }, select: { qty: true, receivedQty: true } });
      const allReceived = items.every((i) => i.receivedQty >= i.qty);
      if (allReceived) {
        await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: "RECEIVED", receivedAt: new Date() } });
      }
      await writeAudit(
        { userId: actor.id, action: "purchase.receive", entity: "purchase_order", entityId: order.id, detail: { receiptNo, lines: plans.length } },
        tx,
      );
      return created;
    });
    return receipt;
  } catch (error) {
    if (error instanceof StockError) throw new PurchaseError(error.message);
    throw error;
  }
}

export type PurchaseTx = Prisma.TransactionClient;
