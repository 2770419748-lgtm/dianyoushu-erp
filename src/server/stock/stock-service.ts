import type { Prisma } from "@/generated/prisma/client";
import type { LedgerDocType } from "@/generated/prisma/enums";
import { ACTION_QTY_DELTA, nextDeviceStatus, type DeviceAction } from "./device-state";
import { isValidImei } from "./imei";

// 库存服务层：全系统唯一能改库存的地方。
// 规则（docs/业务口径.md 第 11 节）：每次变动写一条 stock_ledgers；小件余额表在同一事务里更新并记 balance_after；
// 串号状态只能按状态机走。所有函数都要在调用方的事务（tx）里跑，这样单据、流水、库存要么全成要么全回滚。

export class StockError extends Error {}

export interface ReceiveDevicesInput {
  storeId: number;
  skuId: number;
  imeis: string[]; // 已经解析过的合法串号
  costFen: number;
  docType: LedgerDocType;
  docNo: string;
  operatorId: number;
  goodsReceiptId?: number;
  tradeInOrderId?: number;
  condition?: string;
  note?: string;
}

/** 新机器入库：一台一条 devices + 一条流水。串号必须 15 位数字且全局唯一。 */
export async function receiveDevices(tx: Prisma.TransactionClient, input: ReceiveDevicesInput): Promise<number[]> {
  if (input.imeis.length === 0) throw new StockError("没有要入库的串号");
  const bad = input.imeis.filter((i) => !isValidImei(i));
  if (bad.length > 0) throw new StockError(`串号格式不对（要 15 位数字）：${bad.slice(0, 5).join("、")}`);
  const unique = new Set(input.imeis);
  if (unique.size !== input.imeis.length) throw new StockError("这批串号里有重复的");

  const existing = await tx.device.findMany({ where: { imei: { in: input.imeis } }, select: { imei: true } });
  if (existing.length > 0) {
    throw new StockError(`这些串号已经在系统里了，不能重复入库：${existing.map((e) => e.imei).slice(0, 5).join("、")}${existing.length > 5 ? " 等" : ""}`);
  }

  const status = nextDeviceStatus(input.tradeInOrderId ? "TRADE_IN" : "RECEIVE", null);
  const ids: number[] = [];
  for (const imei of input.imeis) {
    const device = await tx.device.create({
      data: {
        imei,
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
