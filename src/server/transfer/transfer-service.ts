import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canManageTransfer } from "@/server/auth/permissions";
import { assertStoreAccess, canAccessStoreSafe, storeTableWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { lockRow } from "@/server/db-lock";
import { nextDocNo } from "@/server/stock/doc-no";
import { parseCodeList } from "@/server/stock/imei";
import { applyDeviceAction, changeAccessoryStock, StockError } from "@/server/stock/stock-service";
import { isValidQty, MAX_QTY } from "@/lib/limits";
import { DeviceStateError } from "@/server/stock/device-state";

// 调拨服务层：申请（串号锁定）→ 发出（在途，发出店扣库存）→ 收货（核对串号，收货店加库存，可部分）；申请中可作废（解锁）。
// 库存变动全部交给 stock-service，并和单据放在同一事务。

export class TransferError extends Error {}

function assertCanManage(user: CurrentUser): void {
  if (!canManageTransfer(user.role)) throw new TransferError("只有店长和总部能做调拨");
}

function requireId(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new TransferError(`请选择${label}`);
  return n;
}

function optionalText(value: unknown, max = 200): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new TransferError(`最多 ${max} 个字`);
  return text || null;
}

async function loadStore(id: number) {
  const store = await prisma.store.findUnique({ where: { id }, select: { id: true, code: true, name: true, regionId: true, isActive: true } });
  if (!store || !store.isActive) throw new TransferError("门店不存在或已停用");
  return store;
}

function wrapStockError(error: unknown): never {
  if (error instanceof StockError || error instanceof DeviceStateError) throw new TransferError(error.message);
  throw error;
}

// ---------- 查询 ----------

export const TRANSFER_PAGE_SIZE = 20;

export async function listTransfers(user: CurrentUser, page = 1) {
  const current = clampPage(page);
  const scope = storeTableWhere(user);
  const where = { OR: [{ fromStore: scope }, { toStore: scope }] };
  const [rows, total] = await Promise.all([
    prisma.transferOrder.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (current - 1) * TRANSFER_PAGE_SIZE,
      take: TRANSFER_PAGE_SIZE,
      include: {
        fromStore: { select: { code: true, name: true } },
        toStore: { select: { code: true, name: true } },
        requestedBy: { select: { name: true } },
        items: { select: { qty: true, receivedQty: true, deviceId: true } },
      },
    }),
    prisma.transferOrder.count({ where }),
  ]);
  return { rows, total, page: current, pageSize: TRANSFER_PAGE_SIZE };
}

export type TransferRow = Awaited<ReturnType<typeof listTransfers>>["rows"][number];

export async function getTransfer(user: CurrentUser, id: number) {
  const order = await prisma.transferOrder.findUnique({
    where: { id },
    include: {
      fromStore: { select: { id: true, code: true, name: true, regionId: true } },
      toStore: { select: { id: true, code: true, name: true, regionId: true } },
      requestedBy: { select: { name: true } },
      shippedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      items: {
        orderBy: { id: "asc" },
        include: {
          sku: { select: { name: true, model: { select: { name: true, brand: { select: { name: true } }, category: { select: { kind: true } } } } } },
          device: { select: { id: true, code: true, sn: true, imei1: true, imei2: true, status: true } },
        },
      },
    },
  });
  if (!order) return null;
  const canFrom = canAccessStoreSafe(user, order.fromStore);
  const canTo = canAccessStoreSafe(user, order.toStore);
  if (!canFrom && !canTo) assertStoreAccess(user, order.fromStore); // 抛 PermissionError
  return { ...order, canFrom, canTo };
}

export type TransferDetail = NonNullable<Awaited<ReturnType<typeof getTransfer>>>;

export const TRANSFER_DEVICE_PAGE_SIZE = 20;

/** 新建调拨时可选的机器：发出店在库的；按任意码或商品名在服务端搜，分页（新进的排前面） */
export async function listDevicesForTransfer(user: CurrentUser, storeId: number, query: { q?: string; page?: number } = {}) {
  const store = await loadStore(storeId);
  assertStoreAccess(user, store);
  const text = (query.q ?? "").trim();
  const page = clampPage(query.page);
  const where: Prisma.DeviceWhereInput = {
    storeId,
    status: "IN_STOCK", // 只调在库的；良品（回收转良品）留在本店卖，状态机也不允许它锁定
    ...(text
      ? { OR: [{ code: { contains: text } }, { sn: { contains: text } }, { imei1: { contains: text } }, { imei2: { contains: text } }, { sku: { name: { contains: text, mode: "insensitive" } } }] }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.device.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * TRANSFER_DEVICE_PAGE_SIZE,
      take: TRANSFER_DEVICE_PAGE_SIZE,
      select: { id: true, code: true, sn: true, imei1: true, imei2: true, status: true, sku: { select: { name: true } } },
    }),
    prisma.device.count({ where }),
  ]);
  return { rows, total, page, pageSize: TRANSFER_DEVICE_PAGE_SIZE };
}

export type TransferDevicePage = Awaited<ReturnType<typeof listDevicesForTransfer>>;

export type TransferDeviceOption = TransferDevicePage["rows"][number];

export async function listAccessoriesForTransfer(user: CurrentUser, storeId: number) {
  const store = await loadStore(storeId);
  assertStoreAccess(user, store);
  return prisma.accessoryStock.findMany({
    where: { storeId, qty: { gt: 0 } },
    orderBy: { sku: { name: "asc" } },
    select: { skuId: true, qty: true, sku: { select: { name: true } } },
  });
}

export type TransferAccessoryOption = Awaited<ReturnType<typeof listAccessoriesForTransfer>>[number];

// ---------- 申请 ----------

export interface TransferInput {
  fromStoreId: unknown;
  toStoreId: unknown;
  note?: unknown;
  deviceIds: unknown[];
  accessories: { skuId: unknown; qty: unknown }[];
}

export async function createTransfer(user: CurrentUser, input: TransferInput) {
  assertCanManage(user);
  const fromStoreId = requireId(input.fromStoreId, "发出门店");
  const toStoreId = requireId(input.toStoreId, "收货门店");
  if (fromStoreId === toStoreId) throw new TransferError("发出店和收货店不能是同一家");
  const [fromStore] = await Promise.all([loadStore(fromStoreId), loadStore(toStoreId)]);
  assertStoreAccess(user, fromStore);
  const note = optionalText(input.note);

  const deviceIds = Array.from(new Set((input.deviceIds ?? []).map((v) => requireId(v, "机器"))));
  const accessories = (input.accessories ?? [])
    .map((a) => ({ skuId: requireId(a.skuId, "配件"), qty: Number(a.qty) }))
    .filter((a) => a.qty !== 0);
  for (const a of accessories) {
    if (!Number.isInteger(a.qty) || a.qty <= 0) throw new TransferError("配件数量必须是正整数");
    if (!isValidQty(a.qty)) throw new TransferError(`数量不对：一种配件一次最多调 ${MAX_QTY} 件`);
  }
  if (deviceIds.length === 0 && accessories.length === 0) throw new TransferError("至少要选一台机器或一种配件");

  if (deviceIds.length > 0) {
    const devices = await prisma.device.findMany({
      where: { id: { in: deviceIds }, storeId: fromStoreId, status: "IN_STOCK" },
      select: { id: true },
    });
    if (devices.length !== deviceIds.length) throw new TransferError("有机器不在发出店的在库里（良品不能调拨），刷新后重选");
  }
  for (const a of accessories) {
    const stock = await prisma.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: fromStoreId, skuId: a.skuId } } });
    if (!stock || stock.qty < a.qty) throw new TransferError(`配件库存不够（现有 ${stock?.qty ?? 0}，要调 ${a.qty}）`);
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const orderNo = await nextDocNo(tx, "TR");
      const created = await tx.transferOrder.create({
        data: { orderNo, fromStoreId, toStoreId, note, requestedById: user.id },
      });
      for (const deviceId of deviceIds) {
        const device = await tx.device.findUniqueOrThrow({ where: { id: deviceId }, select: { skuId: true } });
        await tx.transferItem.create({ data: { transferId: created.id, skuId: device.skuId, deviceId, qty: 1 } });
        await applyDeviceAction(tx, { deviceId, action: "LOCK_FOR_TRANSFER", docType: "TRANSFER_LOCK", docNo: orderNo, operatorId: user.id });
      }
      for (const a of accessories) {
        await tx.transferItem.create({ data: { transferId: created.id, skuId: a.skuId, qty: a.qty } });
      }
      await writeAudit({ userId: user.id, action: "transfer.create", entity: "transfer_order", entityId: created.id, detail: { orderNo, devices: deviceIds.length, accessories: accessories.length } }, tx);
      return created;
    });
    return order;
  } catch (error) {
    wrapStockError(error);
  }
}

// ---------- 发出 ----------

export async function shipTransfer(user: CurrentUser, id: number) {
  assertCanManage(user);
  const order = await prisma.transferOrder.findUnique({ where: { id }, include: { fromStore: true, items: true } });
  if (!order) throw new TransferError("调拨单不存在");
  if (order.status !== "REQUESTED") throw new TransferError("只有申请中的调拨单能发出");
  assertStoreAccess(user, order.fromStore);

  try {
    await prisma.$transaction(async (tx) => {
      // 先“抢”状态：只有还是申请中才改成已发出。两个人同时点发出，后一个改到 0 行，整个事务回滚，不会扣两次
      const claimed = await tx.transferOrder.updateMany({ where: { id, status: "REQUESTED" }, data: { status: "SHIPPED", shippedById: user.id, shippedAt: new Date() } });
      if (claimed.count === 0) throw new TransferError("这张调拨单刚被别人处理过（已发出或已作废），刷新后再看");
      for (const item of order.items) {
        if (item.deviceId) {
          await applyDeviceAction(tx, { deviceId: item.deviceId, action: "SHIP", docType: "TRANSFER_OUT", docNo: order.orderNo, operatorId: user.id });
        } else {
          // 配件申请时不占库存，发出时才扣；这期间卖掉了就不够发，调拨单数量不能改，只能作废重开
          await changeAccessoryStock(tx, { storeId: order.fromStoreId, skuId: item.skuId, qtyDelta: -item.qty, docType: "TRANSFER_OUT", docNo: order.orderNo, operatorId: user.id }).catch((error: unknown) => {
            if (error instanceof StockError) throw new TransferError(`${error.message}。要改数量请作废这张调拨单，按现有库存重开`);
            throw error;
          });
        }
      }
      await writeAudit({ userId: user.id, action: "transfer.ship", entity: "transfer_order", entityId: id }, tx);
    });
  } catch (error) {
    wrapStockError(error);
  }
}

// ---------- 收货（可部分） ----------

export interface ReceiveTransferInput {
  imeiText?: unknown;
  accessoryLines?: { itemId: unknown; qty: unknown }[];
}

export async function receiveTransfer(user: CurrentUser, id: number, input: ReceiveTransferInput) {
  assertCanManage(user);
  const head = await prisma.transferOrder.findUnique({ where: { id }, include: { toStore: true } });
  if (!head) throw new TransferError("调拨单不存在");
  assertStoreAccess(user, head.toStore);

  // 收到的码：SN、IMEI1、IMEI2 哪个都行，对上同一台算一台
  const parsed = parseCodeList(typeof input.imeiText === "string" ? input.imeiText : "");
  if (parsed.invalid.length > 0) throw new TransferError(`有格式不对的码：${parsed.invalid.slice(0, 3).join("、")}`);
  const lines: { itemId: number; qty: number }[] = [];
  for (const line of input.accessoryLines ?? []) {
    const itemId = requireId(line.itemId, "配件行");
    const qty = Number(line.qty ?? 0);
    if (qty === 0) continue;
    if (!Number.isInteger(qty) || qty < 0) throw new TransferError("收货数量必须是正整数");
    lines.push({ itemId, qty });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 锁住调拨单再读明细：两个人同时收货，后一个会读到前一个收完的“已收数量”，超收会被拦下
      await lockRow(tx, "transfer_orders", id);
      const order = await tx.transferOrder.findUniqueOrThrow({
        where: { id },
        include: { items: { include: { device: { select: { code: true, sn: true, imei1: true, imei2: true } }, sku: { select: { name: true } } } } },
      });
      if (order.status !== "SHIPPED") throw new TransferError("只有已发出的调拨单能收货（可能刚被别人收完了，刷新后再看）");

      const pendingDeviceItems = order.items.filter((i) => i.deviceId && i.receivedQty < i.qty);
      const byCode = new Map<string, (typeof pendingDeviceItems)[number]>();
      for (const item of pendingDeviceItems) {
        for (const c of [item.device!.code, item.device!.sn, item.device!.imei1, item.device!.imei2]) if (c) byCode.set(c, item);
      }
      const unknown = parsed.valid.filter((c) => !byCode.has(c));
      if (unknown.length > 0) throw new TransferError(`这些码不在这张调拨单的待收清单里：${unknown.slice(0, 3).join("、")}`);
      const deviceItems = Array.from(new Set(parsed.valid.map((c) => byCode.get(c)!)));

      const accessoryPlans: { item: (typeof order.items)[number]; qty: number }[] = [];
      for (const line of lines) {
        const item = order.items.find((i) => i.id === line.itemId && !i.deviceId);
        if (!item) throw new TransferError("配件行不属于这张单");
        const remaining = item.qty - item.receivedQty;
        if (line.qty > remaining) throw new TransferError(`${item.sku.name}：还差 ${remaining} 件，录了 ${line.qty} 件`);
        accessoryPlans.push({ item, qty: line.qty });
      }
      if (deviceItems.length === 0 && accessoryPlans.length === 0) throw new TransferError("没有填任何收到的串号或数量");

      for (const item of deviceItems) {
        await applyDeviceAction(tx, {
          deviceId: item.deviceId!,
          action: "TRANSFER_RECEIVE",
          docType: "TRANSFER_IN",
          docNo: order.orderNo,
          operatorId: user.id,
          newStoreId: order.toStoreId,
        });
        await tx.transferItem.update({ where: { id: item.id }, data: { receivedQty: 1, receivedAt: new Date() } });
      }
      for (const plan of accessoryPlans) {
        await changeAccessoryStock(tx, { storeId: order.toStoreId, skuId: plan.item.skuId, qtyDelta: plan.qty, docType: "TRANSFER_IN", docNo: order.orderNo, operatorId: user.id });
        await tx.transferItem.update({ where: { id: plan.item.id }, data: { receivedQty: { increment: plan.qty }, receivedAt: new Date() } });
      }
      const items = await tx.transferItem.findMany({ where: { transferId: id }, select: { qty: true, receivedQty: true } });
      const allReceived = items.every((i) => i.receivedQty >= i.qty);
      await tx.transferOrder.update({
        where: { id },
        data: allReceived ? { status: "RECEIVED", receivedById: user.id, receivedAt: new Date() } : { receivedById: user.id },
      });
      await writeAudit({ userId: user.id, action: "transfer.receive", entity: "transfer_order", entityId: id, detail: { devices: deviceItems.length, accessories: accessoryPlans.length, complete: allReceived } }, tx);
    });
  } catch (error) {
    wrapStockError(error);
  }
}

// ---------- 作废 ----------

export async function voidTransfer(user: CurrentUser, id: number) {
  assertCanManage(user);
  const order = await prisma.transferOrder.findUnique({ where: { id }, include: { fromStore: true, items: true } });
  if (!order) throw new TransferError("调拨单不存在");
  if (order.status !== "REQUESTED") throw new TransferError("只有申请中的调拨单能作废；已发出的请收货后再处理");
  assertStoreAccess(user, order.fromStore);
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.transferOrder.updateMany({ where: { id, status: "REQUESTED" }, data: { status: "VOIDED", voidedAt: new Date() } });
      if (claimed.count === 0) throw new TransferError("这张调拨单刚被别人处理过（已发出或已作废），刷新后再看");
      for (const item of order.items) {
        if (item.deviceId) {
          await applyDeviceAction(tx, { deviceId: item.deviceId, action: "UNLOCK", docType: "TRANSFER_UNLOCK", docNo: order.orderNo, operatorId: user.id });
        }
      }
      await writeAudit({ userId: user.id, action: "transfer.void", entity: "transfer_order", entityId: id }, tx);
    });
  } catch (error) {
    wrapStockError(error);
  }
}
