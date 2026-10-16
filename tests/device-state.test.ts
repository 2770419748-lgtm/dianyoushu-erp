import { describe, expect, it } from "vitest";
import { ACTION_QTY_DELTA, canSell, DeviceStateError, nextDeviceStatus } from "@/server/stock/device-state";

describe("串号状态机", () => {
  it("采购入库：新机器变在库", () => {
    expect(nextDeviceStatus("RECEIVE", null)).toBe("IN_STOCK");
    expect(() => nextDeviceStatus("RECEIVE", "IN_STOCK")).toThrow(DeviceStateError);
  });

  it("调拨：在库 → 锁定 → 在途 → 在库；锁定可解锁", () => {
    expect(nextDeviceStatus("LOCK_FOR_TRANSFER", "IN_STOCK")).toBe("LOCKED");
    expect(nextDeviceStatus("SHIP", "LOCKED")).toBe("IN_TRANSIT");
    expect(nextDeviceStatus("TRANSFER_RECEIVE", "IN_TRANSIT")).toBe("IN_STOCK");
    expect(nextDeviceStatus("UNLOCK", "LOCKED")).toBe("IN_STOCK");
    expect(() => nextDeviceStatus("SHIP", "IN_STOCK")).toThrow(DeviceStateError); // 没申请就发
  });

  it("开单：只有在库和良品能卖；在途、锁定、回收不能卖", () => {
    expect(nextDeviceStatus("SELL", "IN_STOCK")).toBe("SOLD");
    expect(nextDeviceStatus("SELL", "REFURBISHED")).toBe("SOLD");
    for (const status of ["IN_TRANSIT", "LOCKED", "RECYCLED", "SOLD", "LOST"] as const) {
      expect(() => nextDeviceStatus("SELL", status)).toThrow(DeviceStateError);
      expect(canSell(status)).toBe(false);
    }
  });

  it("作废、退货回在库；回收机回良品", () => {
    expect(nextDeviceStatus("VOID_SALE", "SOLD")).toBe("IN_STOCK");
    expect(nextDeviceStatus("RETURN", "SOLD")).toBe("IN_STOCK");
    expect(nextDeviceStatus("RETURN", "SOLD", { recycled: true })).toBe("REFURBISHED");
  });

  it("回收：新建为回收，检测后转良品；盘亏是终态", () => {
    expect(nextDeviceStatus("TRADE_IN", null)).toBe("RECYCLED");
    expect(nextDeviceStatus("REFURBISH", "RECYCLED")).toBe("REFURBISHED");
    expect(nextDeviceStatus("STOCKTAKE_LOSS", "IN_STOCK")).toBe("LOST");
    expect(() => nextDeviceStatus("SELL", "LOST")).toThrow(DeviceStateError);
  });

  it("数量变化：入库 +1、卖出 −1、锁定和转良品不变", () => {
    expect(ACTION_QTY_DELTA.RECEIVE).toBe(1);
    expect(ACTION_QTY_DELTA.SELL).toBe(-1);
    expect(ACTION_QTY_DELTA.LOCK_FOR_TRANSFER).toBe(0);
    expect(ACTION_QTY_DELTA.REFURBISH).toBe(0);
  });
});
