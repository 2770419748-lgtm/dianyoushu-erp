import type { PrismaClient } from "../src/generated/prisma/client";

// 对账自检：账对得上，数字才可信。模拟数据生成完会跑一遍；上线后每天跑一遍（pnpm db:check），对不上要告警。
// 1. 配件余额 = 这家店这个配件所有流水的累计（余额永远能从流水算出来），也等于最后一条流水记的变动后余额；有流水就要有余额行
// 2. 每家店在库机器数 = 机器流水的累计（在库、良品、回收、锁定都算在店里；在途的已经从发出店减掉）
// 3. 每张销售单的收款合计 = 应收（作废的单收款也还在，合计照样相等）
// 4. 已确认的日结，每种收款方式的系统数 = 当天这家店的收款汇总（销售收款 + 退货退款）
//    只查已确认的：没确认的日结白天还在开单，系统数会变，不算对不上。
// 5. 每台机器：状态和归属店 = 它最后一条流水记的状态和门店；没有流水的机器不该存在；
//    "已售"的机器要有一张没退的有效销售单，反过来不是"已售"的机器不该挂着没退的有效销售单
//    （例外：卖出去之后又被回收单收回来的，看那之后有没有回收入库流水）。
// 6. 服务权益：每个服务行有且只有一条权益；单作废了或服务退了，权益就该失效，反过来也一样（已理赔的算没失效）；
//    权益的门店、客户和销售单一致；保的机器退了、服务没退的要记“机器已退回”；服务类商品不该有库存余额和流水；
//    “已理赔”的碎屏险要有一张修好、用碎屏险付、已完结的维修单。
// 7. 维修单（口径第 13 节）：已完结的收款合计 = 客户应付，没完结的没有收款；作废、没完结的不该算营业日。

export interface IntegrityResult {
  accessory: number;
  device: number;
  payment: number;
  dailyClose: number;
  deviceState: number;
  entitlement: number;
  repair: number;
}

export async function runIntegrityChecks(prisma: PrismaClient): Promise<IntegrityResult> {
  const [accessory] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM accessory_stocks a
    LEFT JOIN (SELECT store_id, sku_id, SUM(qty_delta) AS s FROM stock_ledgers WHERE device_id IS NULL GROUP BY store_id, sku_id) l
      ON l.store_id = a.store_id AND l.sku_id = a.sku_id
    WHERE a.qty <> COALESCE(l.s, 0)`;
  const [accessoryLast] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM accessory_stocks a
    JOIN (SELECT DISTINCT ON (store_id, sku_id) store_id, sku_id, balance_after FROM stock_ledgers WHERE device_id IS NULL ORDER BY store_id, sku_id, id DESC) l
      ON l.store_id = a.store_id AND l.sku_id = a.sku_id
    WHERE l.balance_after IS DISTINCT FROM a.qty`;
  const [accessoryOrphan] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM (SELECT DISTINCT store_id, sku_id FROM stock_ledgers WHERE device_id IS NULL) l
    WHERE NOT EXISTS (SELECT 1 FROM accessory_stocks a WHERE a.store_id = l.store_id AND a.sku_id = l.sku_id)`;
  const [device] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM (
      SELECT store_id, COUNT(*) AS c FROM devices WHERE status IN ('IN_STOCK','REFURBISHED','RECYCLED','LOCKED') GROUP BY store_id
    ) d FULL JOIN (
      SELECT store_id, SUM(qty_delta) AS s FROM stock_ledgers WHERE device_id IS NOT NULL GROUP BY store_id
    ) l ON l.store_id = d.store_id
    WHERE COALESCE(d.c, 0) <> COALESCE(l.s, 0)`;
  const [payment] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM sales_orders o
    JOIN (SELECT sales_order_id, SUM(amount_fen) AS s FROM payments WHERE sales_order_id IS NOT NULL GROUP BY sales_order_id) p ON p.sales_order_id = o.id
    WHERE o.total_fen <> p.s`;
  const closeRows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT l.id FROM daily_close_lines l
    JOIN daily_closes c ON c.id = l.daily_close_id AND c.status = 'CONFIRMED'
    LEFT JOIN (
      SELECT o.store_id, o.biz_date, p.method, SUM(p.amount_fen) AS s FROM payments p JOIN sales_orders o ON o.id = p.sales_order_id WHERE o.status = 'COMPLETED' GROUP BY 1, 2, 3
      UNION ALL
      SELECT r.store_id, r.biz_date, p.method, SUM(p.amount_fen) FROM payments p JOIN return_orders r ON r.id = p.return_order_id GROUP BY 1, 2, 3
      UNION ALL
      SELECT w.store_id, w.biz_date, p.method, SUM(p.amount_fen) FROM payments p JOIN repair_orders w ON w.id = p.repair_order_id WHERE w.status = 'CLOSED' GROUP BY 1, 2, 3
    ) x ON x.store_id = c.store_id AND x.biz_date = c.biz_date AND x.method = l.method
    GROUP BY l.id, l.system_fen
    HAVING l.system_fen <> COALESCE(SUM(x.s), 0)`;
  const [deviceLedger] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM devices d
    LEFT JOIN (SELECT DISTINCT ON (device_id) device_id, status_after, store_id FROM stock_ledgers WHERE device_id IS NOT NULL ORDER BY device_id, id DESC) x
      ON x.device_id = d.id
    WHERE x.device_id IS NULL OR x.status_after IS DISTINCT FROM d.status OR x.store_id <> d.store_id`;
  const [deviceSale] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM devices d
    WHERE (d.status = 'SOLD' AND NOT EXISTS (
        SELECT 1 FROM sales_order_items si JOIN sales_orders o ON o.id = si.order_id
        WHERE si.device_id = d.id AND o.status = 'COMPLETED' AND si.returned_qty < si.qty))
      OR (d.status <> 'SOLD' AND EXISTS (
        SELECT 1 FROM sales_order_items si JOIN sales_orders o ON o.id = si.order_id
        WHERE si.device_id = d.id AND o.status = 'COMPLETED' AND si.returned_qty < si.qty
          AND NOT EXISTS (SELECT 1 FROM stock_ledgers l WHERE l.device_id = d.id AND l.doc_type = 'TRADE_IN' AND l.created_at > o.created_at)))`;
  const [entitlement] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM sales_order_items si JOIN skus k ON k.id = si.sku_id
        WHERE k.is_service AND NOT EXISTS (SELECT 1 FROM service_entitlements e WHERE e.sales_order_item_id = si.id))
      + (SELECT COUNT(*) FROM service_entitlements e
        JOIN sales_order_items si ON si.id = e.sales_order_item_id
        JOIN sales_orders o ON o.id = e.sales_order_id
        WHERE si.order_id <> e.sales_order_id
          OR (e.status = 'VOIDED') = (o.status = 'COMPLETED' AND si.returned_qty < si.qty)
          OR e.store_id <> o.store_id OR e.customer_id IS DISTINCT FROM o.customer_id)
      + (SELECT COUNT(*) FROM service_entitlements e
        JOIN sales_order_items di ON di.order_id = e.sales_order_id AND di.device_id = e.device_id
        WHERE e.status = 'ACTIVE' AND di.returned_qty > 0 AND e.device_returned_at IS NULL)
      + (SELECT COUNT(*) FROM service_entitlements e WHERE e.status = 'CLAIMED' AND NOT EXISTS (
          SELECT 1 FROM repair_orders r WHERE r.entitlement_id = e.id AND r.status = 'CLOSED' AND r.outcome = 'REPAIRED' AND r.payer = 'SCREEN_INSURANCE'))
      + (SELECT COUNT(*) FROM stock_ledgers l JOIN skus k ON k.id = l.sku_id WHERE k.is_service)
      + (SELECT COUNT(*) FROM accessory_stocks a JOIN skus k ON k.id = a.sku_id WHERE k.is_service)
    )::bigint AS n`;
  const [repair] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM repair_orders r
        LEFT JOIN (SELECT repair_order_id, SUM(amount_fen) AS s FROM payments WHERE repair_order_id IS NOT NULL GROUP BY repair_order_id) p ON p.repair_order_id = r.id
        WHERE (r.status = 'CLOSED' AND COALESCE(p.s, 0) <> r.charge_fen)
          OR (r.status <> 'CLOSED' AND p.s IS NOT NULL)
          OR ((r.status = 'CLOSED') <> (r.biz_date IS NOT NULL)))
    )::bigint AS n`;
  return {
    accessory: Number(accessory!.n) + Number(accessoryLast!.n) + Number(accessoryOrphan!.n),
    device: Number(device!.n),
    payment: Number(payment!.n),
    dailyClose: closeRows.length,
    deviceState: Number(deviceLedger!.n) + Number(deviceSale!.n),
    entitlement: Number(entitlement!.n),
    repair: Number(repair!.n),
  };
}

export function describeIntegrity(r: IntegrityResult): string {
  return `配件余额对不上 ${r.accessory} 处，机器数对不上 ${r.device} 处，收款 ≠ 应收 ${r.payment} 单，日结系统数对不上 ${r.dailyClose} 行，机器状态和流水、销售单对不上 ${r.deviceState} 台，服务权益和单据对不上 ${r.entitlement} 处，维修单收款对不上 ${r.repair} 张。`;
}

export function integrityOk(r: IntegrityResult): boolean {
  return r.accessory + r.device + r.payment + r.dailyClose + r.deviceState + r.entitlement + r.repair === 0;
}
