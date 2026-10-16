import "server-only";
import { prisma } from "@/lib/prisma";
import { canConfirmStocktake, canEnterStocktake } from "@/server/auth/permissions";
import { assertStoreAccess, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { nextDocNo } from "@/server/stock/doc-no";
import { parseCodeList } from "@/server/stock/imei";
import { applyDeviceAction, changeAccessoryStock, StockError } from "@/server/stock/stock-service";
import { DeviceStateError } from "@/server/stock/device-state";

// 盘点服务层：建任务时把"应有"快照下来 → 录实盘（大件粘串号、小件填数量）→ 自动算差异 → 确认后盘盈盘亏写流水。
// 大件盘亏：机器变"盘亏"；大件盘盈（系统里没有的串号）这版不自动建机器，只在录入结果里提示，由总部走入库处理。

export class StocktakeError extends Error {}

function requireId(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new StocktakeError(`请选择${label}`);
  return n;
}

function optionalText(value: unknown, max = 200): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new StocktakeError(`最多 ${max} 个字`);
  return text || null;
}

function wrapStockError(error: unknown): never {
  if (error instanceof StockError || error instanceof DeviceStateError) throw new StocktakeError(error.message);
  throw error;
}

// ---------- 查询 ----------

export const STOCKTAKE_PAGE_SIZE = 20;

export async function listStocktakes(user: CurrentUser, page = 1) {
  const current = Math.max(1, Math.floor(page) || 1);
  const where = storeScopeWhere(user);
  const [rows, total] = await Promise.all([
    prisma.stocktake.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (current - 1) * STOCKTAKE_PAGE_SIZE,
      take: STOCKTAKE_PAGE_SIZE,
      include: {
        store: { select: { code: true, name: true } },
        createdBy: { select: { name: true } },
        items: { select: { expectedQty: true, countedQty: true, diffQty: true } },
      },
    }),
    prisma.stocktake.count({ where }),
  ]);
  return { rows, total, page: current, pageSize: STOCKTAKE_PAGE_SIZE };
}

export type StocktakeRow = Awaited<ReturnType<typeof listStocktakes>>["rows"][number];

export async function getStocktake(user: CurrentUser, id: number) {
  const stocktake = await prisma.stocktake.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, code: true, name: true, regionId: true } },
      createdBy: { select: { name: true } },
      confirmedBy: { select: { name: true } },
      items: {
        orderBy: { id: "asc" },
        include: {
          sku: { select: { name: true, model: { select: { name: true, brand: { select: { name: true } } } } } },
          device: { select: { code: true, sn: true, imei1: true, imei2: true, status: true } },
        },
      },
    },
  });
  if (!stocktake) return null;
  assertStoreAccess(user, stocktake.store);
  return stocktake;
}

export type StocktakeDetail = NonNullable<Awaited<ReturnType<typeof getStocktake>>>;

// ---------- 建任务 ----------

export async function createStocktake(user: CurrentUser, input: { storeId: unknown; note?: unknown }) {
  if (!canEnterStocktake(user.role)) throw new StocktakeError("你的角色不能发起盘点");
  const storeId = requireId(input.storeId, "门店");
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true, isActive: true } });
  if (!store || !store.isActive) throw new StocktakeError("门店不存在或已停用");
  assertStoreAccess(user, store);
  const note = optionalText(input.note);

  const open = await prisma.stocktake.count({ where: { storeId, status: "IN_PROGRESS" } });
  if (open > 0) throw new StocktakeError("这家店还有一张进行中的盘点单，先完成或作废它");

  const [devices, accessories] = await Promise.all([
    prisma.device.findMany({ where: { storeId, status: { in: ["IN_STOCK", "REFURBISHED"] } }, select: { id: true, skuId: true }, orderBy: { id: "asc" } }),
    prisma.accessoryStock.findMany({ where: { storeId, qty: { gt: 0 } }, select: { skuId: true, qty: true }, orderBy: { skuId: "asc" } }),
  ]);
  if (devices.length === 0 && accessories.length === 0) throw new StocktakeError("这家店现在没有库存，不用盘");

  const stocktake = await prisma.$transaction(async (tx) => {
    const stocktakeNo = await nextDocNo(tx, "ST");
    const created = await tx.stocktake.create({ data: { stocktakeNo, storeId, note, createdById: user.id } });
    await tx.stocktakeItem.createMany({
      data: [
        ...devices.map((d) => ({ stocktakeId: created.id, skuId: d.skuId, deviceId: d.id, expectedQty: 1 })),
        ...accessories.map((a) => ({ stocktakeId: created.id, skuId: a.skuId, expectedQty: a.qty })),
      ],
    });
    await writeAudit({ userId: user.id, action: "stocktake.create", entity: "stocktake", entityId: created.id, detail: { stocktakeNo, devices: devices.length, accessories: accessories.length } }, tx);
    return created;
  });
  return stocktake;
}

// ---------- 录实盘 ----------

export interface EnterCountsInput {
  imeiText?: unknown; // 实盘到的串号，一次全量粘贴
  accessoryCounts?: { itemId: unknown; countedQty: unknown }[];
}

export async function enterCounts(user: CurrentUser, id: number, input: EnterCountsInput) {
  if (!canEnterStocktake(user.role)) throw new StocktakeError("你的角色不能录盘点");
  const stocktake = await prisma.stocktake.findUnique({
    where: { id },
    include: { store: true, items: { include: { device: { select: { code: true, sn: true, imei1: true, imei2: true } } } } },
  });
  if (!stocktake) throw new StocktakeError("盘点单不存在");
  if (stocktake.status !== "IN_PROGRESS") throw new StocktakeError("这张盘点单已经结束");
  assertStoreAccess(user, stocktake.store);

  // 实盘的码：SN、IMEI1、IMEI2 哪个都行
  const parsed = parseCodeList(typeof input.imeiText === "string" ? input.imeiText : "");
  if (parsed.invalid.length > 0) throw new StocktakeError(`有格式不对的码：${parsed.invalid.slice(0, 3).join("、")}`);
  const scanned = new Set(parsed.valid);
  const deviceItems = stocktake.items.filter((i) => i.deviceId);
  const known = new Set<string>();
  for (const i of deviceItems) for (const c of [i.device!.code, i.device!.sn, i.device!.imei1, i.device!.imei2]) if (c) known.add(c);
  const unexpected = parsed.valid.filter((c) => !known.has(c));
  const counted = (item: (typeof deviceItems)[number]) =>
    [item.device!.code, item.device!.sn, item.device!.imei1, item.device!.imei2].some((c) => c && scanned.has(c));

  const accessoryUpdates: { itemId: number; countedQty: number }[] = [];
  for (const line of input.accessoryCounts ?? []) {
    const itemId = requireId(line.itemId, "配件行");
    const item = stocktake.items.find((i) => i.id === itemId && !i.deviceId);
    if (!item) throw new StocktakeError("配件行不属于这张盘点单");
    if (line.countedQty === null || line.countedQty === undefined || line.countedQty === "") continue;
    const qty = Number(line.countedQty);
    if (!Number.isInteger(qty) || qty < 0) throw new StocktakeError("实盘数量必须是不小于 0 的整数");
    accessoryUpdates.push({ itemId, countedQty: qty });
  }

  await prisma.$transaction(async (tx) => {
    for (const item of deviceItems) {
      const countedQty = counted(item) ? 1 : 0;
      await tx.stocktakeItem.update({ where: { id: item.id }, data: { countedQty, diffQty: countedQty - item.expectedQty } });
    }
    for (const u of accessoryUpdates) {
      const item = stocktake.items.find((i) => i.id === u.itemId)!;
      await tx.stocktakeItem.update({ where: { id: u.itemId }, data: { countedQty: u.countedQty, diffQty: u.countedQty - item.expectedQty } });
    }
    await writeAudit({ userId: user.id, action: "stocktake.count", entity: "stocktake", entityId: id, detail: { scanned: parsed.valid.length, unexpected: unexpected.length } }, tx);
  });

  return { scanned: parsed.valid.length, matched: parsed.valid.length - unexpected.length, unexpected };
}

// ---------- 确认 ----------

export async function confirmStocktake(user: CurrentUser, id: number) {
  if (!canConfirmStocktake(user.role)) throw new StocktakeError("只有店长和总部能确认盘点");
  const stocktake = await prisma.stocktake.findUnique({ where: { id }, include: { store: true, items: true } });
  if (!stocktake) throw new StocktakeError("盘点单不存在");
  if (stocktake.status !== "IN_PROGRESS") throw new StocktakeError("这张盘点单已经结束");
  assertStoreAccess(user, stocktake.store);
  const notCounted = stocktake.items.filter((i) => i.countedQty === null);
  if (notCounted.length > 0) throw new StocktakeError(`还有 ${notCounted.length} 项没录实盘，先录完再确认`);

  try {
    await prisma.$transaction(async (tx) => {
      let lossDevices = 0;
      let accessoryDiff = 0;
      for (const item of stocktake.items) {
        const diff = (item.countedQty ?? 0) - item.expectedQty;
        if (diff === 0) continue;
        if (item.deviceId) {
          await applyDeviceAction(tx, { deviceId: item.deviceId, action: "STOCKTAKE_LOSS", docType: "STOCKTAKE_LOSS", docNo: stocktake.stocktakeNo, operatorId: user.id, note: "盘点确认盘亏" });
          lossDevices++;
        } else {
          await changeAccessoryStock(tx, {
            storeId: stocktake.storeId,
            skuId: item.skuId,
            qtyDelta: diff,
            docType: diff > 0 ? "STOCKTAKE_GAIN" : "STOCKTAKE_LOSS",
            docNo: stocktake.stocktakeNo,
            operatorId: user.id,
            note: diff > 0 ? "盘点确认盘盈" : "盘点确认盘亏",
          });
          accessoryDiff += diff;
        }
      }
      await tx.stocktake.update({ where: { id }, data: { status: "CONFIRMED", confirmedById: user.id, confirmedAt: new Date() } });
      await writeAudit({ userId: user.id, action: "stocktake.confirm", entity: "stocktake", entityId: id, detail: { lossDevices, accessoryDiff } }, tx);
    });
  } catch (error) {
    wrapStockError(error);
  }
}

export async function voidStocktake(user: CurrentUser, id: number) {
  if (!canConfirmStocktake(user.role)) throw new StocktakeError("只有店长和总部能作废盘点");
  const stocktake = await prisma.stocktake.findUnique({ where: { id }, include: { store: true } });
  if (!stocktake) throw new StocktakeError("盘点单不存在");
  if (stocktake.status !== "IN_PROGRESS") throw new StocktakeError("这张盘点单已经结束");
  assertStoreAccess(user, stocktake.store);
  await prisma.stocktake.update({ where: { id }, data: { status: "VOIDED", voidedAt: new Date() } });
  await writeAudit({ userId: user.id, action: "stocktake.void", entity: "stocktake", entityId: id });
}
