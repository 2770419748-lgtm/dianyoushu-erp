import type { DeviceStatus } from "@/generated/prisma/enums";

// 串号状态机（docs/业务口径.md 第 4 节）。纯函数，所有状态跳转都必须经过 nextDeviceStatus。

export type DeviceAction =
  | "RECEIVE" // 采购到货入库
  | "LOCK_FOR_TRANSFER" // 调拨申请提交
  | "UNLOCK" // 调拨作废
  | "SHIP" // 调拨发出
  | "TRANSFER_RECEIVE" // 调拨收货
  | "SELL" // 开单售出
  | "VOID_SALE" // 销售单作废
  | "RETURN" // 退货
  | "TRADE_IN" // 回收单收旧机
  | "REFURBISH" // 回收机转良品
  | "STOCKTAKE_LOSS" // 盘点确认盘亏
  | "STOCKTAKE_GAIN"; // 盘点确认盘盈

export class DeviceStateError extends Error {}

/** from 为 null 表示这个动作会新建一台机器 */
const TRANSITIONS: Record<DeviceAction, { from: DeviceStatus[] | null; to: DeviceStatus }> = {
  RECEIVE: { from: null, to: "IN_STOCK" },
  LOCK_FOR_TRANSFER: { from: ["IN_STOCK"], to: "LOCKED" },
  UNLOCK: { from: ["LOCKED"], to: "IN_STOCK" },
  SHIP: { from: ["LOCKED"], to: "IN_TRANSIT" },
  TRANSFER_RECEIVE: { from: ["IN_TRANSIT"], to: "IN_STOCK" },
  SELL: { from: ["IN_STOCK", "REFURBISHED"], to: "SOLD" },
  VOID_SALE: { from: ["SOLD"], to: "IN_STOCK" },
  RETURN: { from: ["SOLD"], to: "IN_STOCK" },
  TRADE_IN: { from: null, to: "RECYCLED" },
  REFURBISH: { from: ["RECYCLED"], to: "REFURBISHED" },
  STOCKTAKE_LOSS: { from: ["IN_STOCK", "REFURBISHED"], to: "LOST" },
  STOCKTAKE_GAIN: { from: null, to: "IN_STOCK" },
};

/** 库存数量怎么变：+1、−1 或 0（只改状态） */
export const ACTION_QTY_DELTA: Record<DeviceAction, 1 | 0 | -1> = {
  RECEIVE: 1,
  LOCK_FOR_TRANSFER: 0,
  UNLOCK: 0,
  SHIP: -1,
  TRANSFER_RECEIVE: 1,
  SELL: -1,
  VOID_SALE: 1,
  RETURN: 1,
  TRADE_IN: 1,
  REFURBISH: 0,
  STOCKTAKE_LOSS: -1,
  STOCKTAKE_GAIN: 1,
};

/** 能开单卖的状态 */
export const SELLABLE_STATUSES: DeviceStatus[] = ["IN_STOCK", "REFURBISHED"];

export const DEVICE_STATUS_LABELS: Record<DeviceStatus, string> = {
  IN_TRANSIT: "在途",
  IN_STOCK: "在库",
  SOLD: "已售",
  RECYCLED: "回收",
  REFURBISHED: "良品",
  LOCKED: "锁定",
  LOST: "盘亏",
};

/**
 * 算下一个状态；不合法就抛 DeviceStateError。
 * recycled：这台是回收机时，作废/退货回到"良品"而不是"在库"。
 */
export function nextDeviceStatus(action: DeviceAction, current: DeviceStatus | null, opts: { recycled?: boolean } = {}): DeviceStatus {
  const rule = TRANSITIONS[action];
  if (rule.from === null) {
    if (current !== null) throw new DeviceStateError(`"${action}" 只能用于新机器，这台已经是"${DEVICE_STATUS_LABELS[current]}"`);
    return rule.to;
  }
  if (current === null || !rule.from.includes(current)) {
    const label = current === null ? "不存在" : DEVICE_STATUS_LABELS[current];
    throw new DeviceStateError(`机器当前是"${label}"，不能执行 ${action}`);
  }
  if ((action === "VOID_SALE" || action === "RETURN") && opts.recycled) return "REFURBISHED";
  return rule.to;
}

export function canSell(status: DeviceStatus): boolean {
  return SELLABLE_STATUSES.includes(status);
}
