import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { DeviceStatus } from "@/generated/prisma/enums";
import { maskPhone } from "@/lib/sales-labels";
import { canRefurbish, canSell } from "@/server/auth/permissions";
import { assertStoreAccess, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { nextDocNo } from "@/server/stock/doc-no";
import { DeviceStateError } from "@/server/stock/device-state";
import { parseDeviceCodeLines } from "@/server/stock/imei";
import { applyDeviceAction, receiveDevices, StockError } from "@/server/stock/stock-service";

// 回收单（以旧换新收旧机，口径第 7 节）：
// 估价店员手填；提交后旧机进本店回收库（串号状态"回收"，成本 = 估价）；
// 一张回收单只能抵扣一张销售单；店长或总部确认后"回收 → 良品"，良品可以再开单卖。

export class TradeInError extends Error {}

type Tx = Prisma.TransactionClient;

export const CONDITION_OPTIONS = ["全新", "95 新", "9 成新", "8 成新", "有损"] as const;

/** 种子里预置的"其他机型"回收 SKU：旧机对不上现有型号时选它，真实机型写在 modelName */
export const GENERIC_TRADE_IN_SKU_NAME = "回收机（其他机型）";

function wrap(error: unknown): never {
  if (error instanceof StockError || error instanceof DeviceStateError) throw new TradeInError(error.message);
  throw error;
}

export interface TradeInInput {
  storeId: unknown;
  customerId?: unknown;
  codesText: unknown; // 旧机的 SN / IMEI1 / IMEI2，一行，1 到 3 个
  skuId: unknown;
  modelName?: unknown;
  condition: unknown;
  appraisedFen: unknown;
  note?: unknown;
}

export async function createTradeInTx(tx: Tx, user: CurrentUser, input: TradeInInput) {
  if (!canSell(user.role)) throw new TradeInError("你的角色不能开回收单");
  const storeId = Number(input.storeId);
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true, isActive: true } });
  if (!store || !store.isActive) throw new TradeInError("门店不存在或已停用");
  assertStoreAccess(user, store);

  const parsed = parseDeviceCodeLines(typeof input.codesText === "string" ? input.codesText : "");
  if (parsed.errors.length > 0) throw new TradeInError(parsed.errors[0]!);
  if (parsed.devices.length !== 1) throw new TradeInError("一张回收单收一台旧机：填这台的 SN / IMEI1 / IMEI2，至少一个，写在一行");
  const codes = parsed.devices[0]!;

  const skuId = Number(input.skuId);
  const sku = Number.isInteger(skuId) && skuId > 0 ? await tx.sku.findUnique({ where: { id: skuId }, include: { model: { include: { brand: true, category: true } } } }) : null;
  if (!sku) throw new TradeInError("请选旧机机型（对不上就选“回收机（其他机型）”并写清机型）");
  if (sku.model.category.kind !== "DEVICE") throw new TradeInError("回收的必须是大件");
  const typedModel = typeof input.modelName === "string" ? input.modelName.trim().slice(0, 60) : "";
  const modelName = typedModel || `${sku.model.brand.name} ${sku.name}`;
  if (sku.name === GENERIC_TRADE_IN_SKU_NAME && !typedModel) throw new TradeInError("选了“其他机型”要写清旧机是什么型号");

  const condition = typeof input.condition === "string" ? input.condition : "";
  if (!(CONDITION_OPTIONS as readonly string[]).includes(condition)) throw new TradeInError("请选成色");
  const appraisedFen = Number(input.appraisedFen);
  if (!Number.isInteger(appraisedFen) || appraisedFen <= 0) throw new TradeInError("估价要大于 0");
  if (appraisedFen > 5_000_000) throw new TradeInError("估价太大了，检查一下");

  let customerId: number | null = null;
  if (input.customerId) {
    customerId = Number(input.customerId);
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new TradeInError("客户不存在");
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) || null : null;

  const orderNo = await nextDocNo(tx, "RC");
  const order = await tx.tradeInOrder.create({
    data: { orderNo, storeId, customerId, handledById: user.id, deviceCode: codes.code, modelName, skuId: sku.id, condition, appraisedFen, note },
  });
  try {
    await receiveDevices(tx, {
      storeId,
      skuId: sku.id,
      devices: [{ sn: codes.sn, imei1: codes.imei1, imei2: codes.imei2 }],
      costFen: appraisedFen,
      docType: "TRADE_IN",
      docNo: orderNo,
      operatorId: user.id,
      tradeInOrderId: order.id,
      condition,
      note: modelName,
    });
  } catch (error) {
    wrap(error);
  }
  await writeAudit({ userId: user.id, action: "trade_in.create", entity: "trade_in_order", entityId: order.id, detail: { orderNo, appraisedFen, deviceCode: codes.code } }, tx);
  return { id: order.id, orderNo, appraisedFen, deviceCode: codes.code, modelName };
}

export async function createTradeIn(user: CurrentUser, input: TradeInInput) {
  return prisma.$transaction((tx) => createTradeInTx(tx, user, input));
}

/** 回收机转良品：回收 → 良品，数量不变，写一条流水（口径第 4 节） */
export async function refurbishTx(tx: Tx, user: CurrentUser, deviceId: number) {
  if (!canRefurbish(user.role)) throw new TradeInError("只有店长和总部能把回收机转良品");
  const device = await tx.device.findUnique({ where: { id: deviceId }, include: { store: { select: { id: true, regionId: true } }, tradeInOrder: { select: { orderNo: true } } } });
  if (!device) throw new TradeInError("机器不存在");
  assertStoreAccess(user, device.store);
  if (device.status !== "RECYCLED") throw new TradeInError("只有“回收”状态的机器能转良品");
  try {
    await applyDeviceAction(tx, { deviceId, action: "REFURBISH", docType: "REFURBISH", docNo: device.tradeInOrder?.orderNo ?? device.code, operatorId: user.id, note: "检测合格转良品" });
  } catch (error) {
    wrap(error);
  }
  await writeAudit({ userId: user.id, action: "trade_in.refurbish", entity: "device", entityId: deviceId, detail: { code: device.code } }, tx);
}

export async function refurbish(user: CurrentUser, deviceId: number) {
  return prisma.$transaction((tx) => refurbishTx(tx, user, deviceId));
}

// ---------- 查询 ----------

export const TRADE_IN_PAGE_SIZE = 20;

export async function listTradeIns(user: CurrentUser, page = 1) {
  const current = clampPage(page);
  const where = storeScopeWhere(user);
  const [rows, total] = await Promise.all([
    prisma.tradeInOrder.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (current - 1) * TRADE_IN_PAGE_SIZE,
      take: TRADE_IN_PAGE_SIZE,
      include: {
        store: { select: { code: true, name: true } },
        customer: { select: { name: true, phone: true } },
        handledBy: { select: { name: true } },
        device: { select: { code: true, status: true } },
        salesOrder: { select: { id: true, orderNo: true, status: true } },
      },
    }),
    prisma.tradeInOrder.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, customer: r.customer ? { name: r.customer.name, phoneMasked: maskPhone(r.customer.phone) } : null })),
    total,
    page: current,
    pageSize: TRADE_IN_PAGE_SIZE,
  };
}

export type TradeInRow = Awaited<ReturnType<typeof listTradeIns>>["rows"][number];

export const RECYCLED_PAGE_SIZE = 20;

/** 回收库存：本范围内状态为"回收"（等待检测）和"良品"的机器，分页（总部能看到几百台） */
export async function listRecycledDevices(user: CurrentUser, page = 1) {
  const where = { AND: [storeScopeWhere(user), { status: { in: ["RECYCLED", "REFURBISHED"] as DeviceStatus[] } }] };
  const current = clampPage(page);
  const [rows, total] = await Promise.all([
    prisma.device.findMany({
      where,
      orderBy: [{ status: "asc" }, { id: "desc" }],
      skip: (current - 1) * RECYCLED_PAGE_SIZE,
      take: RECYCLED_PAGE_SIZE,
      include: {
        sku: { select: { name: true } },
        store: { select: { code: true, name: true } },
        tradeInOrder: { select: { orderNo: true, modelName: true, appraisedFen: true, createdAt: true } },
      },
    }),
    prisma.device.count({ where }),
  ]);
  return { rows, total, page: current, pageSize: RECYCLED_PAGE_SIZE };
}

export type RecycledDeviceRow = Awaited<ReturnType<typeof listRecycledDevices>>["rows"][number];

/** 开单时可抵扣的回收单：本店、已完成、还没被任何销售单用过 */
export async function listAvailableTradeIns(user: CurrentUser, storeId: number) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true } });
  if (!store) return [];
  assertStoreAccess(user, store);
  const rows = await prisma.tradeInOrder.findMany({
    where: { storeId, status: "COMPLETED", salesOrder: null },
    orderBy: { id: "desc" },
    take: 30,
    include: { customer: { select: { name: true, phone: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    orderNo: r.orderNo,
    modelName: r.modelName,
    deviceCode: r.deviceCode,
    appraisedFen: r.appraisedFen,
    customer: r.customer ? `${r.customer.name} ${maskPhone(r.customer.phone)}` : null,
  }));
}

export type AvailableTradeIn = Awaited<ReturnType<typeof listAvailableTradeIns>>[number];

/** 回收单可选的旧机机型：在售大件 SKU，"其他机型"排最前 */
export async function listTradeInSkuOptions() {
  const skus = await prisma.sku.findMany({
    where: { isActive: true, model: { category: { kind: "DEVICE" } } },
    orderBy: [{ model: { brand: { name: "asc" } } }, { name: "asc" }],
    select: { id: true, name: true, model: { select: { brand: { select: { name: true } } } } },
  });
  return skus
    .map((s) => ({ id: s.id, label: s.name === GENERIC_TRADE_IN_SKU_NAME ? s.name : `${s.model.brand.name} ${s.name}`, generic: s.name === GENERIC_TRADE_IN_SKU_NAME }))
    .sort((a, b) => Number(b.generic) - Number(a.generic));
}
