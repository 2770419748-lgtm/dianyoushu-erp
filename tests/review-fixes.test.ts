import { describe, expect, it } from "vitest";
import { breadcrumbFor } from "@/lib/routes";
import { clampPage } from "@/lib/paging";
import { returnRefundCapFen } from "@/server/sales/payments";

// 2026-10-17 全面自检修的几处纯函数。

describe("面包屑", () => {
  it("没有页面的中间一级不做链接（点了会 404）", () => {
    const crumbs = breadcrumbFor("/stock/devices/868200000000011");
    expect(crumbs.map((c) => c.title)).toEqual(["首页", "库存", "串号", "868200000000011"]);
    expect(crumbs[1]!.href).toBe("/stock");
    expect(crumbs[2]!.href).toBeUndefined();
    expect(breadcrumbFor("/reports/cashier")[1]!.href).toBeUndefined();
  });

  it("机器详情最后一段显示码本身：IMEI 和 SN 一样处理", () => {
    expect(breadcrumbFor("/stock/devices/SNDEMO2001").at(-1)!.title).toBe("SNDEMO2001");
    expect(breadcrumbFor("/stock/devices/868200000000011").at(-1)!.title).toBe("868200000000011");
    expect(breadcrumbFor("/sales/12").at(-1)!.title).toBe("详情");
  });
});

describe("这一次退货最多能退多少", () => {
  const order = { subtotalFen: 525800, totalFen: 525800 }; // 机器 5199 + 配件 59，没有优惠
  const cash = [{ method: "CASH" as const, amountFen: 525800 }];
  const lines = [
    { lineTotalFen: 519900, qty: 1, returnQty: 0 },
    { lineTotalFen: 5900, qty: 1, returnQty: 1 },
  ];

  it("只退配件：最多退这件配件的钱，不能把整单退走", () => {
    expect(returnRefundCapFen(lines, order, cash, 0)).toBe(5900);
  });

  it("有整单优惠时按比例分摊", () => {
    // 合计 5258，优惠 58 → 应收 5200；退 59 的配件，最多退 59 × 5200 / 5258 ≈ 58.35
    expect(returnRefundCapFen(lines, { subtotalFen: 525800, totalFen: 520000 }, [{ method: "CASH", amountFen: 520000 }], 0)).toBe(5835);
  });

  it("以旧换新抵扣的部分不退：退机器时上限是实付减已退", () => {
    const pays = [
      { method: "TRADE_IN" as const, amountFen: 120000 },
      { method: "WECHAT" as const, amountFen: 405800 },
    ];
    const deviceOnly = [
      { lineTotalFen: 519900, qty: 1, returnQty: 1 },
      { lineTotalFen: 5900, qty: 1, returnQty: 0 },
    ];
    expect(returnRefundCapFen(deviceOnly, order, pays, 0)).toBe(405800);
    expect(returnRefundCapFen(deviceOnly, order, pays, 5900)).toBe(399900);
  });
});

describe("页码", () => {
  it("非法或过大的页码收拢到 1 到 10000", () => {
    expect(clampPage(undefined)).toBe(1);
    expect(clampPage("abc")).toBe(1);
    expect(clampPage(-3)).toBe(1);
    expect(clampPage(2.7)).toBe(2);
    expect(clampPage(99999999999)).toBe(10000);
  });
});
