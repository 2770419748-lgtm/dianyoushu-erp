import type { PrismaClient } from "../src/generated/prisma/client";

// 对账自检（4 条 SQL）：账对得上，数字才可信。模拟数据生成完会跑一遍；上线后每天跑一遍（pnpm db:check），对不上要告警。
// 1. 配件余额 = 这家店这个配件所有流水的累计（余额永远能从流水算出来）
// 2. 每家店在库机器数 = 机器流水的累计（在库、良品、回收、锁定都算在店里；在途的已经从发出店减掉）
// 3. 每张销售单的收款合计 = 应收（作废的单收款也还在，合计照样相等）
// 4. 已确认的日结，每种收款方式的系统数 = 当天这家店的收款汇总（销售收款 + 退货退款）
//    只查已确认的：没确认的日结白天还在开单，系统数会变，不算对不上。

export interface IntegrityResult {
  accessory: number;
  device: number;
  payment: number;
  dailyClose: number;
}

export async function runIntegrityChecks(prisma: PrismaClient): Promise<IntegrityResult> {
  const [accessory] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM accessory_stocks a
    LEFT JOIN (SELECT store_id, sku_id, SUM(qty_delta) AS s FROM stock_ledgers WHERE device_id IS NULL GROUP BY store_id, sku_id) l
      ON l.store_id = a.store_id AND l.sku_id = a.sku_id
    WHERE a.qty <> COALESCE(l.s, 0)`;
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
    ) x ON x.store_id = c.store_id AND x.biz_date = c.biz_date AND x.method = l.method
    GROUP BY l.id, l.system_fen
    HAVING l.system_fen <> COALESCE(SUM(x.s), 0)`;
  return { accessory: Number(accessory!.n), device: Number(device!.n), payment: Number(payment!.n), dailyClose: closeRows.length };
}

export function describeIntegrity(r: IntegrityResult): string {
  return `配件余额对不上 ${r.accessory} 处，机器数对不上 ${r.device} 处，收款 ≠ 应收 ${r.payment} 单，日结系统数对不上 ${r.dailyClose} 行。`;
}

export function integrityOk(r: IntegrityResult): boolean {
  return r.accessory + r.device + r.payment + r.dailyClose === 0;
}
