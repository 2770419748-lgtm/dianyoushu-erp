import type { Prisma } from "@/generated/prisma/client";
import type { LedgerDocType } from "@/generated/prisma/enums";
import { ACTION_QTY_DELTA, nextDeviceStatus, type DeviceAction } from "./device-state";
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
    const device = await tx.device.create({
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

/** 小件库存增减：余额表 + 流水在同一事务里；出库不能把余额扣成负数。 */
export async function changeAccessoryStock(tx: Prisma.TransactionClient, input: AccessoryDeltaInput): Promise<number> {
  if (!Number.isInteger(input.qtyDelta) || input.qtyDelta === 0) throw new StockError("数量必须是非 0 整数");
  const current = await tx.accessoryStock.findUnique({ where: { storeId_skuId: { storeId: input.storeId, skuId: input.skuId } } });
  const before = current?.qty ?? 0;
  const after = before + input.qtyDelta;
  if (after < 0) throw new StockError(`库存不够：现有 ${before}，要出 ${-input.qtyDelta}`);

  await tx.accessoryStock.upsert({
    where: { storeId_skuId: { storeId: input.storeId, skuId: input.skuId } },
    update: { qty: after },
    create: { storeId: input.storeId, skuId: input.skuId, qty: after },
  });
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
  action: Exclude<DeviceAction, "RECEIVE" | "TRADE_IN" | "STOCKTAKE_GAIN">;
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

  const updated = await tx.device.update({
    where: { id: device.id },
    data: { status: statusAfter, ...(input.newStoreId ? { storeId: input.newStoreId } : {}) },
  });
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
