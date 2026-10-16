import type { DeviceStatus, LedgerDocType, PurchaseOrderStatus, StocktakeStatus, TransferStatus } from "@/generated/prisma/enums";

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  REQUESTED: "申请中",
  SHIPPED: "已发出",
  RECEIVED: "已收货",
  VOIDED: "已作废",
};

export const TRANSFER_STATUS_COLORS: Record<TransferStatus, string> = {
  REQUESTED: "orange",
  SHIPPED: "gold",
  RECEIVED: "green",
  VOIDED: "red",
};

export const STOCKTAKE_STATUS_LABELS: Record<StocktakeStatus, string> = {
  IN_PROGRESS: "进行中",
  CONFIRMED: "已确认",
  VOIDED: "已作废",
};

export const STOCKTAKE_STATUS_COLORS: Record<StocktakeStatus, string> = {
  IN_PROGRESS: "blue",
  CONFIRMED: "green",
  VOIDED: "red",
};

// 库存相关枚举的中文说明。纯数据，客户端服务端都能用。

export const DEVICE_STATUS_LABELS: Record<DeviceStatus, string> = {
  IN_TRANSIT: "在途",
  IN_STOCK: "在库",
  SOLD: "已售",
  RECYCLED: "回收",
  REFURBISHED: "良品",
  LOCKED: "锁定",
  LOST: "盘亏",
};

export const DEVICE_STATUS_COLORS: Record<DeviceStatus, string> = {
  IN_TRANSIT: "gold",
  IN_STOCK: "green",
  SOLD: "default",
  RECYCLED: "purple",
  REFURBISHED: "cyan",
  LOCKED: "orange",
  LOST: "red",
};

export const LEDGER_DOC_TYPE_LABELS: Record<LedgerDocType, string> = {
  PURCHASE_RECEIPT: "采购入库",
  TRANSFER_LOCK: "调拨锁定",
  TRANSFER_UNLOCK: "调拨解锁",
  TRANSFER_OUT: "调拨发出",
  TRANSFER_IN: "调拨收货",
  STOCKTAKE_GAIN: "盘盈",
  STOCKTAKE_LOSS: "盘亏",
  SALE: "销售出库",
  SALE_VOID: "销售作废",
  RETURN: "退货入库",
  TRADE_IN: "回收入库",
  REFURBISH: "转良品",
};

export const PURCHASE_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  DRAFT: "草稿",
  SUBMITTED: "已提交",
  RECEIVED: "已到货",
  VOIDED: "已作废",
};

export const PURCHASE_STATUS_COLORS: Record<PurchaseOrderStatus, string> = {
  DRAFT: "default",
  SUBMITTED: "blue",
  RECEIVED: "green",
  VOIDED: "red",
};
