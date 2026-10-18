import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import { canConfirmStocktake, canEnterStocktake } from "@/server/auth/permissions";
import { assertStoreAccess, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { nextDocNo } from "@/server/stock/doc-no";
import { parseCodeList } from "@/server/stock/imei";
import { applyDeviceAction, changeAccessoryStock, StockError } from "@/server/stock/stock-service";
import { DeviceStateError } from "@/server/stock/device-state";
import { isValidQty, MAX_QTY } from "@/lib/limits";
import { lockRow } from "@/server/db-lock";

// 盘点服务层：建任务时把"应有"快照下来 → 录实盘（大件粘串号、小件填数量；应有刷新成录入那一刻的系统数）→ 自动算差异 → 确认后把差异加到当时余额上、写流水。
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
  const current = clampPage(page);
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
//
// 盘点期间门店照常营业，所以“应有”不能只用建单时的快照：
// - 录实盘时，把每个配件行的“应有”刷新成这一刻的系统数量，差异 = 实盘 − 这一刻的应有；
// - 机器行：这一刻已经不在本店或不能卖了（期间卖掉、调走）的，应有记 0，不算盘亏；
// - 确认时把差异当作“增减量”加到确认那一刻的余额上：录完之后又卖掉的，余额已经减过，不会重复扣。

export interface EnterCountsInput {
  imeiText?: unknown; // 实盘到的码，一次全量粘贴；留空表示这次不改机器的实盘
  accessoryCounts?: { itemId: unknown; countedQty: unknown }[];
}

const SELLABLE_IN_STORE = ["IN_STOCK", "REFURBISHED"] as const;

function stillInStore(device: { storeId: number; status: string } | null, storeId: number): boolean {
  return device !== null && device.storeId === storeId && (SELLABLE_IN_STORE as readonly string[]).includes(device.status);
}

export async function enterCounts(user: CurrentUser, id: number, input: EnterCountsInput) {
  if (!canEnterStocktake(user.role)) throw new StocktakeError("你的角色不能录盘点");
  const head = await prisma.stocktake.findUnique({ where: { id }, include: { store: true } });
  if (!head) throw new StocktakeError("盘点单不存在");
  assertStoreAccess(user, head.store);

  // 实盘的码：SN、IMEI1、IMEI2 哪个都行
  const text = typeof input.imeiText === "string" ? input.imeiText : "";
  const parsed = parseCodeList(text);
  if (parsed.invalid.length > 0) throw new StocktakeError(`有格式不对的码：${parsed.invalid.slice(0, 3).join("、")}`);
  const updateDevices = text.trim() !== "";
  const scanned = new Set(parsed.valid);

  const counts: { itemId: number; countedQty: number }[] = [];
  for (const line of input.accessoryCounts ?? []) {
    const itemId = requireId(line.itemId, "配件行");
    if (line.countedQty === null || line.countedQty === undefined || line.countedQty === "") continue;
    const qty = Number(line.countedQty);
    if (!Number.isInteger(qty) || qty < 0) throw new StocktakeError("实盘数量必须是不小于 0 的整数");
    if (!isValidQty(qty, true)) throw new StocktakeError(`数量不对：实盘数量最多 ${MAX_QTY}`);
    counts.push({ itemId, countedQty: qty });
  }

  return prisma.$transaction(async (tx) => {
    // 锁住这张盘点单再读：两个人同时保存、一边保存一边确认，都会排队
    await lockRow(tx, "stocktakes", id);
    const stocktake = await tx.stocktake.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { device: { select: { code: true, sn: true, imei1: true, imei2: true, storeId: true, status: true } } } } },
    });
    if (stocktake.status !== "IN_PROGRESS") throw new StocktakeError("这张盘点单已经结束");

    const deviceItems = stocktake.items.filter((i) => i.deviceId);
    const known = new Set<string>();
    for (const i of deviceItems) for (const c of [i.device!.code, i.device!.sn, i.device!.imei1, i.device!.imei2]) if (c) known.add(c);
    const unexpected = parsed.valid.filter((c) => !known.has(c));

    if (updateDevices) {
      for (const item of deviceItems) {
        const d = item.device!;
        const countedQty = [d.code, d.sn, d.imei1, d.imei2].some((c) => c && scanned.has(c)) ? 1 : 0;
        const expectedQty = stillInStore(d, stocktake.storeId) ? 1 : 0;
        await tx.stocktakeItem.update({ where: { id: item.id }, data: { countedQty, expectedQty, diffQty: countedQty - expectedQty } });
      }
    }
    for (const c of counts) {
      const item = stocktake.items.find((i) => i.id === c.itemId && !i.deviceId);
      if (!item) throw new StocktakeError("配件行不属于这张盘点单");
      const stock = await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: stocktake.storeId, skuId: item.skuId } }, select: { qty: true } });
      const expectedQty = stock?.qty ?? 0;
      await tx.stocktakeItem.update({ where: { id: item.id }, data: { countedQty: c.countedQty, expectedQty, diffQty: c.countedQty - expectedQty } });
    }
    await writeAudit({ userId: user.id, action: "stocktake.count", entity: "stocktake", entityId: id, detail: { scanned: parsed.valid.length, unexpected: unexpected.length, devicesUpdated: updateDevices } }, tx);
    return { scanned: parsed.valid.length, matched: parsed.valid.length - unexpected.length, unexpected };
  });
}

// ---------- 确认 ----------

export async function confirmStocktake(user: CurrentUser, id: number) {
  if (!canConfirmStocktake(user.role)) throw new StocktakeError("只有店长和总部能确认盘点");
  const head = await prisma.stocktake.findUnique({ where: { id }, include: { store: true } });
  if (!head) throw new StocktakeError("盘点单不存在");
  assertStoreAccess(user, head.store);

  try {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, "stocktakes", id);
      const stocktake = await tx.stocktake.findUniqueOrThrow({ where: { id }, include: { items: { include: { device: { select: { storeId: true, status: true } } } } } });
      if (stocktake.status !== "IN_PROGRESS") throw new StocktakeError("这张盘点单已经结束");
      const notCounted = stocktake.items.filter((i) => i.countedQty === null);
      if (notCounted.length > 0) throw new StocktakeError(`还有 ${notCounted.length} 项没录实盘，先录完再确认`);

      let lossDevices = 0;
      let accessoryDiff = 0;
      for (const item of stocktake.items) {
        if (item.deviceId) {
          // 只有“现在仍在本店、能卖、却没盘到”的才记盘亏；录完之后才卖掉、调走的，有单据可查，不算
          if (item.countedQty === 0 && stillInStore(item.device, stocktake.storeId)) {
            await applyDeviceAction(tx, { deviceId: item.deviceId, action: "STOCKTAKE_LOSS", docType: "STOCKTAKE_LOSS", docNo: stocktake.stocktakeNo, operatorId: user.id, note: "盘点确认盘亏" });
            lossDevices++;
          } else if (item.countedQty === 0 && item.expectedQty === 1) {
            await tx.stocktakeItem.update({ where: { id: item.id }, data: { expectedQty: 0, diffQty: 0 } });
          }
          continue;
        }
        // 配件：录实盘时的差异，加到现在的余额上（录完之后的进出已经在余额里了）
        const diff = item.diffQty ?? 0;
        if (diff === 0) continue;
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
      await tx.stocktake.update({ where: { id }, data: { status: "CONFIRMED", confirmedById: user.id, confirmedAt: new Date() } });
      await writeAudit({ userId: user.id, action: "stocktake.confirm", entity: "stocktake", entityId: id, detail: { lossDevices, accessoryDiff } }, tx);
    });
  } catch (error) {
    if (error instanceof StockError && /库存不够/.test(error.message)) {
      throw new StocktakeError(`录实盘之后又有出库，有配件不够扣了：${error.message}。请重新录一遍实盘再确认`);
    }
    wrapStockError(error);
  }
}

export async function voidStocktake(user: CurrentUser, id: number) {
  if (!canConfirmStocktake(user.role)) throw new StocktakeError("只有店长和总部能作废盘点");
  const head = await prisma.stocktake.findUnique({ where: { id }, include: { store: true } });
  if (!head) throw new StocktakeError("盘点单不存在");
  assertStoreAccess(user, head.store);
  await prisma.$transaction(async (tx) => {
    const changed = await tx.stocktake.updateMany({ where: { id, status: "IN_PROGRESS" }, data: { status: "VOIDED", voidedAt: new Date() } });
    if (changed.count === 0) throw new StocktakeError("这张盘点单已经结束");
    await writeAudit({ userId: user.id, action: "stocktake.void", entity: "stocktake", entityId: id }, tx);
  });
}
