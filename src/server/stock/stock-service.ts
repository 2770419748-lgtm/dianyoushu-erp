import type { Prisma } from "@/generated/prisma/client";
import type { LedgerDocType } from "@/generated/prisma/enums";
import { ACTION_QTY_DELTA, nextDeviceStatus, type DeviceAction } from "./device-state";
import { isUniqueViolation } from "@/server/db-errors";
import { isValidImei, isValidSn, primaryCode, type DeviceCodes } from "./imei";

// 库存服务层：全系统唯一能改库存的地方。
// 规则（docs/业务口径.md 第 11 节）：每次变动写一条 stock_ledgers；小件余额表在同一事务里更新并记 balance_after；
// 串号状态只能按状态机走。所有函数都要在调用方的事务（tx）里跑，这样单据、流水、库存要么全成要么全回滚。

export class StockError extends Error {}

export interface ReceiveDevicesInput {
  storeId: number;
  skuId: number;
  devices: DeviceCodes[]; // 每台 1 到 3 个码（SN / IMEI1 / IMEI2），至少一个
  costFen: number;
  docType: LedgerDocType;
  docNo: string;
  operatorId: number;
  goodsReceiptId?: number;
  tradeInOrderId?: number;
  condition?: string;
  note?: string;
}

/** 新机器入库：一台一条 devices + 一条流水。三个码各自全局唯一。 */
export async function receiveDevices(tx: Prisma.TransactionClient, input: ReceiveDevicesInput): Promise<number[]> {
  if (input.devices.length === 0) throw new StockError("没有要入库的机器");

  const seen = new Set<string>();
  const prepared = input.devices.map((d, index) => {
    const codes: DeviceCodes = { sn: d.sn || null, imei1: d.imei1 || null, imei2: d.imei2 || null };
    for (const imei of [codes.imei1, codes.imei2]) {
      if (imei !== null && !isValidImei(imei)) throw new StockError(`第 ${index + 1} 台：IMEI “${imei}” 要 15 位数字`);
    }
    if (codes.sn !== null && !isValidSn(codes.sn)) throw new StockError(`第 ${index + 1} 台：SN “${codes.sn}” 格式不对（6 到 30 位字母数字）`);
    const code = primaryCode(codes);
    if (!code) throw new StockError(`第 ${index + 1} 台：SN、IMEI1、IMEI2 至少填一个`);
    for (const c of [codes.sn, codes.imei1, codes.imei2]) {
      if (c === null) continue;
      if (seen.has(c)) throw new StockError(`这批里 ${c} 出现了两次`);
      seen.add(c);
    }
    return { ...codes, code };
  });

  const allCodes = Array.from(seen);
  const existing = await tx.device.findMany({
    where: { OR: [{ code: { in: allCodes } }, { sn: { in: allCodes } }, { imei1: { in: allCodes } }, { imei2: { in: allCodes } }] },
    select: { code: true, sn: true, imei1: true, imei2: true },
  });
  if (existing.length > 0) {
    const hit = new Set<string>();
    for (const e of existing) for (const c of [e.code, e.sn, e.imei1, e.imei2]) if (c && seen.has(c)) hit.add(c);
    const list = Array.from(hit);
    throw new StockError(`这些码已经在系统里了，不能重复入库：${list.slice(0, 5).join("、")}${list.length > 5 ? " 等" : ""}`);
  }

  const status = nextDeviceStatus(input.tradeInOrderId ? "TRADE_IN" : "RECEIVE", null);
  const ids: number[] = [];
  for (const d of prepared) {
    let device;
    try {
      device = await tx.device.create({
        data: {
          code: d.code,
          sn: d.sn,
          imei1: d.imei1,
          imei2: d.imei2,
          skuId: input.skuId,
          storeId: input.storeId,
          status,
          costFen: input.costFen,
          condition: input.condition,
          goodsReceiptId: input.goodsReceiptId,
          tradeInOrderId: input.tradeInOrderId,
        },
      });
    } catch (error) {
      // 上面已经查过重复；还撞上唯一约束，说明同一时间别人也在入这台机器
      if (isUniqueViolation(error)) throw new StockError(`${d.code} 已经在系统里了（可能刚被别人入库），不能重复入库`);
      throw error;
    }
    await tx.stockLedger.create({
      data: {
        docType: input.docType,
        docNo: input.docNo,
        storeId: input.storeId,
        skuId: input.skuId,
        deviceId: device.id,
        qtyDelta: 1,
        statusBefore: null,
        statusAfter: status,
        operatorId: input.operatorId,
        note: input.note,
      },
    });
    ids.push(device.id);
  }
  return ids;
}

export interface RetakeSoldDeviceInput {
  deviceId: number;
  storeId: number; // 回收店：机器归到这家店
  costFen: number; // 成本改成这次的估价
  condition: string;
  tradeInOrderId: number;
  fillCodes: { sn?: string; imei1?: string; imei2?: string }; // 系统里还空着、这次填了的码，顺手补上
  docNo: string;
  operatorId: number;
  note?: string;
}

/**
 * 本系统卖出去的机器被客户拿回来以旧换新：串号全局唯一，不能再新建一条，
 * 就把原来那条机器记录改成“回收”、归到回收店、成本改成估价、挂上这张回收单，写一条回收入库流水。
 * 只认“已售”：在库、锁定、在途等状态由状态机拒绝。原销售单的明细和成本快照不动。
 */
export async function retakeSoldDevice(tx: Prisma.TransactionClient, input: RetakeSoldDeviceInput) {
  const device = await tx.device.findUnique({ where: { id: input.deviceId } });
  if (!device) throw new StockError("机器不存在");
  const statusAfter = nextDeviceStatus("TRADE_IN_SOLD", device.status);
  let changed;
  try {
    changed = await tx.device.updateMany({
      where: { id: device.id, status: device.status },
      data: { status: statusAfter, storeId: input.storeId, costFen: input.costFen, condition: input.condition, tradeInOrderId: input.tradeInOrderId, ...input.fillCodes },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new StockError(`补填的码刚被别的机器用了，检查一下 ${device.code} 的码有没有填错`);
    throw error;
  }
  if (changed.count === 0) throw new StockError(`${device.code} 刚被别人操作过（状态已经变了），刷新后再试`);
  await tx.stockLedger.create({
    data: {
      docType: "TRADE_IN",
      docNo: input.docNo,
      storeId: input.storeId,
      skuId: device.skuId,
      deviceId: device.id,
      qtyDelta: ACTION_QTY_DELTA.TRADE_IN_SOLD,
      statusBefore: device.status,
      statusAfter,
      operatorId: input.operatorId,
      note: input.note,
    },
  });
  return tx.device.findUniqueOrThrow({ where: { id: device.id } });
}

/** 按任意一个码找机器（扫码、盘点、收货都用它） */
export function deviceCodeWhere(code: string): Prisma.DeviceWhereInput {
  return { OR: [{ code }, { sn: code }, { imei1: code }, { imei2: code }] };
}

export interface AccessoryDeltaInput {
  storeId: number;
  skuId: number;
  qtyDelta: number; // 正入负出，不能为 0
  docType: LedgerDocType;
  docNo: string;
  operatorId: number;
  note?: string;
}

/**
 * 小件库存增减：余额表 + 流水在同一事务里；出库不能把余额扣成负数。
 * 并发安全：不“先读余额、算好再写回”（两个人同时卖最后一件会都读到 1、都写 0），
 * 而是让数据库原子地加减：出库用“余额够才减”的条件更新，入库用 increment；
 * 数据库上还有 qty >= 0 的检查约束兜底（迁移 integrity_checks）。
 */
export async function changeAccessoryStock(tx: Prisma.TransactionClient, input: AccessoryDeltaInput): Promise<number> {
  if (!Number.isInteger(input.qtyDelta) || input.qtyDelta === 0) throw new StockError("数量必须是非 0 整数");
  const key = { storeId_skuId: { storeId: input.storeId, skuId: input.skuId } };
  let after: number;
  if (input.qtyDelta < 0) {
    const need = -input.qtyDelta;
    const changed = await tx.accessoryStock.updateMany({
      where: { storeId: input.storeId, skuId: input.skuId, qty: { gte: need } },
      data: { qty: { decrement: need } },
    });
    if (changed.count === 0) {
      const current = await tx.accessoryStock.findUnique({ where: key, select: { qty: true } });
      throw new StockError(`库存不够：现有 ${current?.qty ?? 0}，要出 ${need}`);
    }
    after = (await tx.accessoryStock.findUniqueOrThrow({ where: key, select: { qty: true } })).qty;
  } else {
    const row = await tx.accessoryStock.upsert({
      where: key,
      update: { qty: { increment: input.qtyDelta } },
      create: { storeId: input.storeId, skuId: input.skuId, qty: input.qtyDelta },
    });
    after = row.qty;
  }
  await tx.stockLedger.create({
    data: {
      docType: input.docType,
      docNo: input.docNo,
      storeId: input.storeId,
      skuId: input.skuId,
      qtyDelta: input.qtyDelta,
      balanceAfter: after,
      operatorId: input.operatorId,
      note: input.note,
    },
  });
  return after;
}

export interface DeviceActionInput {
  deviceId: number;
  action: Exclude<DeviceAction, "RECEIVE" | "TRADE_IN" | "TRADE_IN_SOLD">;
  docType: LedgerDocType;
  docNo: string;
  operatorId: number;
  newStoreId?: number; // 调拨收货时改归属
  note?: string;
}

/** 已有机器的状态变化（卖出、锁定、发出、收货、退货、转良品、盘亏……），按状态机校验。 */
export async function applyDeviceAction(tx: Prisma.TransactionClient, input: DeviceActionInput) {
  const device = await tx.device.findUnique({ where: { id: input.deviceId } });
  if (!device) throw new StockError("机器不存在");
  const statusAfter = nextDeviceStatus(input.action, device.status, { recycled: device.tradeInOrderId !== null });
  const qtyDelta = ACTION_QTY_DELTA[input.action];
  // 发出记在发出店，收货记在收货店；其余记在当前归属店
  const ledgerStoreId = input.action === "TRANSFER_RECEIVE" ? (input.newStoreId ?? device.storeId) : device.storeId;

  // 并发安全：条件写入。只有状态还是刚才读到的那个才改，否则说明这期间别人已经动了这台机器
  // （比如两个店员同时卖同一台：都读到“在库”，但只有先提交的那个能改成“已售”，后一个改 0 行、整单回滚）。
  const changed = await tx.device.updateMany({
    where: { id: device.id, status: device.status },
    data: { status: statusAfter, ...(input.newStoreId ? { storeId: input.newStoreId } : {}) },
  });
  if (changed.count === 0) throw new StockError(`${device.code} 刚被别人操作过（状态已经变了），刷新后再试`);
  const updated = await tx.device.findUniqueOrThrow({ where: { id: device.id } });
  await tx.stockLedger.create({
    data: {
      docType: input.docType,
      docNo: input.docNo,
      storeId: ledgerStoreId,
      skuId: device.skuId,
      deviceId: device.id,
      qtyDelta,
      statusBefore: device.status,
      statusAfter,
      operatorId: input.operatorId,
      note: input.note,
    },
  });
  return updated;
}

// ---------- 期初入库（数据导入，口径第 22 节）----------

export interface OpeningDevice {
  storeId: number;
  skuId: number;
  codes: DeviceCodes; // 导入预检已经查过格式和重复
  costFen: number;
}

/**
 * 期初入库一批机器：直接“在库”，一台一条期初流水（单号 = 期初入库单号）。
 * 一批可能几千台，按 1000 台一组批量写；码在预检时查过重复，这里撞上唯一约束说明同一时间有人入了同一台。
 */
export async function openingReceiveDevices(tx: Prisma.TransactionClient, input: { docNo: string; operatorId: number; devices: OpeningDevice[] }): Promise<number> {
  const status = nextDeviceStatus("RECEIVE", null);
  let created = 0;
  for (let i = 0; i < input.devices.length; i += 1000) {
    const chunk = input.devices.slice(i, i + 1000).map((d) => {
      const code = primaryCode(d.codes);
      if (!code) throw new StockError("SN、IMEI1、IMEI2 至少填一个");
      return { code, sn: d.codes.sn, imei1: d.codes.imei1, imei2: d.codes.imei2, skuId: d.skuId, storeId: d.storeId, status, costFen: d.costFen };
    });
    let rows: { id: number; storeId: number; skuId: number }[];
    try {
      rows = await tx.device.createManyAndReturn({ data: chunk, select: { id: true, storeId: true, skuId: true } });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StockError("有机器的码刚被别人入库了，重新上传预检一次");
      throw error;
    }
    await tx.stockLedger.createMany({
      data: rows.map((r) => ({ docType: "OPENING" as const, docNo: input.docNo, storeId: r.storeId, skuId: r.skuId, deviceId: r.id, qtyDelta: 1, statusBefore: null, statusAfter: status, operatorId: input.operatorId })),
    });
    created += rows.length;
  }
  return created;
}

/**
 * 撤销一张期初入库单的库存（口径第 22 节，调用方先确认系统里还没开过销售单）：
 * - 机器：都还在原店在库、除了这条期初流水没有别的流水，才删掉机器和流水；
 * - 配件：这家店这个商品在期初之后没有别的流水，才把数量减回去、删掉期初流水。
 * 有一条不满足就整张不撤，报出是哪台、哪个商品。
 */
export async function revokeOpeningStock(tx: Prisma.TransactionClient, docNo: string): Promise<{ devices: number; accessories: number }> {
  const ledgers = await tx.stockLedger.findMany({ where: { docNo, docType: "OPENING" }, select: { id: true, storeId: true, skuId: true, deviceId: true, qtyDelta: true } });
  const deviceIds = ledgers.flatMap((l) => (l.deviceId === null ? [] : [l.deviceId]));
  if (deviceIds.length > 0) {
    const moved = await tx.device.findFirst({
      where: { id: { in: deviceIds }, OR: [{ status: { not: "IN_STOCK" } }, { ledgers: { some: { NOT: { docNo, docType: "OPENING" } } } }] },
      select: { code: true },
    });
    if (moved) throw new StockError(`机器 ${moved.code} 已经有别的进出记录（卖了、调了、盘了），这张期初入库单不能撤销`);
    const storeChanged = await tx.$queryRaw<{ code: string }[]>`
      SELECT d.code FROM devices d JOIN stock_ledgers l ON l.device_id = d.id
      WHERE l.doc_no = ${docNo} AND l.doc_type = 'OPENING' AND d.store_id <> l.store_id LIMIT 1`;
    if (storeChanged.length > 0) throw new StockError(`机器 ${storeChanged[0]!.code} 已经不在原来的门店，这张期初入库单不能撤销`);
  }
  const accessoryRows = ledgers.filter((l) => l.deviceId === null);
  for (const row of accessoryRows) {
    const later = await tx.stockLedger.findFirst({ where: { storeId: row.storeId, skuId: row.skuId, id: { gt: row.id } }, select: { id: true } });
    if (later) {
      const sku = await tx.sku.findUnique({ where: { id: row.skuId }, select: { name: true } });
      throw new StockError(`配件“${sku?.name ?? row.skuId}”在期初之后有别的进出记录，这张期初入库单不能撤销`);
    }
    const changed = await tx.accessoryStock.updateMany({ where: { storeId: row.storeId, skuId: row.skuId, qty: { gte: row.qtyDelta } }, data: { qty: { decrement: row.qtyDelta } } });
    if (changed.count !== 1) throw new StockError("配件数量对不上，这张期初入库单不能撤销");
  }
  await tx.stockLedger.deleteMany({ where: { docNo, docType: "OPENING" } });
  if (deviceIds.length > 0) await tx.device.deleteMany({ where: { id: { in: deviceIds } } });
  return { devices: deviceIds.length, accessories: accessoryRows.length };
}
