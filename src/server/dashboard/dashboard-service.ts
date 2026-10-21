import "server-only";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import type { CurrentUser } from "@/server/auth/current-user";
import { listStoresInScope } from "@/server/org/store-query";
import { GENERIC_TRADE_IN_SKU_NAME } from "@/server/tradein/trade-in-service";
import { dailyGap, timeProgress, turnoverDays, type DayStoreRow } from "./metrics";

// 经营看板（第 9 周）：6 张图的数据都在这里算，全部按数据范围（店长本店、区域经理辖区、总部全部）。
// 口径：销售额 = 已完成销售单应收 − 退货退款；毛利 = 成交额 − 成本快照 − 整单优惠（退货扣回）；主机量 = 售出大件台数（退货扣减）。

const DAY_MS = 86400000;
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const n = (v: unknown) => Number(v ?? 0);

export async function getDashboard(user: CurrentUser, storeFilter?: number) {
  const scopeStores = await listStoresInScope(user);
  const stores = storeFilter ? scopeStores.filter((s) => s.id === storeFilter) : scopeStores;
  const ids = stores.map((s) => s.id);
  const today = formatDate(new Date());
  const monthStart = `${today.slice(0, 8)}01`;
  const from90 = formatDate(new Date(toDate(today).getTime() - 89 * DAY_MS));
  const from30 = formatDate(new Date(toDate(today).getTime() - 29 * DAY_MS));
  if (ids.length === 0) return null;

  // 1. 门店 × 天：销售、毛利、单数、主机量（近 90 天）；旧机回收单独按回收单数
  const salesRows = await prisma.$queryRaw<{ store_id: number; d: string; orders: number; sales: bigint; profit: bigint; devices: number }[]>`
    WITH o AS (
      SELECT id, store_id, biz_date, total_fen, discount_fen, trade_in_order_id FROM sales_orders
      WHERE status = 'COMPLETED' AND store_id = ANY(${ids}) AND biz_date >= ${toDate(from90)}
    ), i AS (
      SELECT order_id, SUM(line_total_fen - cost_fen) AS g, SUM(CASE WHEN device_id IS NOT NULL THEN qty ELSE 0 END) AS dev
      FROM sales_order_items WHERE order_id IN (SELECT id FROM o) GROUP BY order_id
    )
    SELECT o.store_id, to_char(o.biz_date, 'YYYY-MM-DD') AS d, COUNT(*)::int AS orders, SUM(o.total_fen)::bigint AS sales,
           SUM(COALESCE(i.g, 0) - o.discount_fen)::bigint AS profit, SUM(COALESCE(i.dev, 0))::int AS devices
    FROM o LEFT JOIN i ON i.order_id = o.id GROUP BY 1, 2`;
  const returnRows = await prisma.$queryRaw<{ store_id: number; d: string; refund: bigint; loss: bigint; devices: number }[]>`
    SELECT r.store_id, to_char(r.biz_date, 'YYYY-MM-DD') AS d, SUM(ri.refund_fen)::bigint AS refund,
           SUM(ri.refund_fen - si.cost_fen * ri.qty / si.qty)::bigint AS loss,
           SUM(CASE WHEN ri.device_id IS NOT NULL THEN ri.qty ELSE 0 END)::int AS devices
    FROM return_orders r JOIN return_order_items ri ON ri.return_order_id = r.id JOIN sales_order_items si ON si.id = ri.sales_item_id
    WHERE r.store_id = ANY(${ids}) AND r.biz_date >= ${toDate(from90)} GROUP BY 1, 2`;
  // 旧机回收（口径第 9 节）：按回收单的建单日期（北京时间）数台数，不管有没有被开单抵扣；作废的不算
  const tradeInRows = await prisma.$queryRaw<{ store_id: number; d: string; n: number }[]>`
    SELECT store_id, to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
    FROM trade_in_orders
    WHERE status = 'COMPLETED' AND store_id = ANY(${ids}) AND created_at >= ${toDate(from90)}
    GROUP BY 1, 2`;
  const key = (storeId: number, d: string) => `${storeId}|${d}`;
  const daily = new Map<string, DayStoreRow>();
  for (const r of salesRows) daily.set(key(r.store_id, r.d), { storeId: r.store_id, date: r.d, sales: n(r.sales), profit: n(r.profit), orders: r.orders, devices: r.devices, tradeIns: 0 });
  for (const r of returnRows) {
    const row = daily.get(key(r.store_id, r.d)) ?? { storeId: r.store_id, date: r.d, sales: 0, profit: 0, orders: 0, devices: 0, tradeIns: 0 };
    row.sales -= n(r.refund);
    row.profit -= n(r.loss);
    row.devices -= r.devices;
    daily.set(key(r.store_id, r.d), row);
  }
  for (const t of tradeInRows) {
    const row = daily.get(key(t.store_id, t.d)) ?? { storeId: t.store_id, date: t.d, sales: 0, profit: 0, orders: 0, devices: 0, tradeIns: 0 };
    row.tradeIns = t.n;
    daily.set(key(t.store_id, t.d), row);
  }
  const dayRows = [...daily.values()];

  // 日销趋势（近 30 天，范围内合计）
  const trendDates: string[] = [];
  for (let t = toDate(from30).getTime(); t <= toDate(today).getTime(); t += DAY_MS) trendDates.push(formatDate(new Date(t)));
  const trend = trendDates.map((d) => {
    const rows = dayRows.filter((r) => r.date === d);
    return { date: d, sales: rows.reduce((s, r) => s + r.sales, 0), profit: rows.reduce((s, r) => s + r.profit, 0), orders: rows.reduce((s, r) => s + r.orders, 0) };
  });

  // 门店月销对比（近 3 个自然月）
  const months = [...new Set(dayRows.map((r) => r.date.slice(0, 7)))].sort().slice(-3);
  const storeMonth = stores.map((s) => ({
    storeId: s.id,
    label: `${s.code} ${s.name}`,
    months: months.map((m) => dayRows.filter((r) => r.storeId === s.id && r.date.startsWith(m)).reduce((sum, r) => sum + r.sales, 0)),
  }));

  // 本月汇总与 KPI 完成率、日均差额
  const monthRows = dayRows.filter((r) => r.date >= monthStart);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const targets = await prisma.kpiTarget.findMany({ where: { storeId: { in: ids }, year: y, month: m } });
  const progress = timeProgress(today);
  const kpi = stores.map((s) => {
    const rows = monthRows.filter((r) => r.storeId === s.id);
    const actual = { sales: rows.reduce((a, r) => a + r.sales, 0), profit: rows.reduce((a, r) => a + r.profit, 0), devices: rows.reduce((a, r) => a + r.devices, 0), tradeIns: rows.reduce((a, r) => a + r.tradeIns, 0) };
    const target = targets.find((t) => t.storeId === s.id);
    const gap = target ? dailyGap(target.salesTargetFen, actual.sales, today) : null;
    return {
      storeId: s.id,
      label: `${s.code} ${s.name}`,
      actual,
      target: target ? { sales: target.salesTargetFen, profit: target.profitTargetFen, devices: target.deviceQtyTarget, tradeIns: target.tradeInQtyTarget } : null,
      salesRate: target && target.salesTargetFen > 0 ? actual.sales / target.salesTargetFen : null,
      profitRate: target && target.profitTargetFen > 0 ? actual.profit / target.profitTargetFen : null,
      deviceRate: target && target.deviceQtyTarget > 0 ? actual.devices / target.deviceQtyTarget : null,
      gap,
    };
  });

  // 员工业绩排名（本月，按销售额，前 10）
  const staffRows = await prisma.$queryRaw<{ user_id: number; name: string; store: string; orders: number; sales: bigint; profit: bigint; devices: number }[]>`
    WITH o AS (
      SELECT id, salesperson_id, store_id, total_fen, discount_fen FROM sales_orders
      WHERE status = 'COMPLETED' AND store_id = ANY(${ids}) AND biz_date >= ${toDate(monthStart)}
    ), i AS (
      SELECT order_id, SUM(line_total_fen - cost_fen) AS g, SUM(CASE WHEN device_id IS NOT NULL THEN qty ELSE 0 END) AS dev
      FROM sales_order_items WHERE order_id IN (SELECT id FROM o) GROUP BY order_id
    )
    SELECT u.id AS user_id, u.name, s.name AS store, COUNT(*)::int AS orders, SUM(o.total_fen)::bigint AS sales,
           SUM(COALESCE(i.g, 0) - o.discount_fen)::bigint AS profit, SUM(COALESCE(i.dev, 0))::int AS devices
    FROM o LEFT JOIN i ON i.order_id = o.id JOIN users u ON u.id = o.salesperson_id JOIN stores s ON s.id = o.store_id
    GROUP BY u.id, u.name, s.name ORDER BY SUM(o.total_fen) DESC LIMIT 10`;

  // 热销机型 TOP10（近 30 天，按台数；回收机不算）
  const hotRows = await prisma.$queryRaw<{ model: string; qty: number; sales: bigint }[]>`
    SELECT b.name || ' ' || m.name AS model, SUM(si.qty)::int AS qty, SUM(si.line_total_fen)::bigint AS sales
    FROM sales_order_items si
    JOIN sales_orders o ON o.id = si.order_id
    JOIN skus k ON k.id = si.sku_id JOIN product_models m ON m.id = k.model_id JOIN brands b ON b.id = m.brand_id
    WHERE o.status = 'COMPLETED' AND o.store_id = ANY(${ids}) AND o.biz_date >= ${toDate(from30)} AND si.device_id IS NOT NULL AND k.name <> ${GENERIC_TRADE_IN_SKU_NAME}
    GROUP BY 1 ORDER BY 2 DESC LIMIT 10`;

  // 库存周转和滞销预警：在库台数、近 30 天卖出台数、周转天数；在库超过 30 天的机器按型号列出
  const stockRows = await prisma.$queryRaw<{ store_id: number; in_stock: number; stale: number; sold30: number }[]>`
    SELECT s.id AS store_id,
      (SELECT COUNT(*)::int FROM devices d WHERE d.store_id = s.id AND d.status IN ('IN_STOCK', 'REFURBISHED')) AS in_stock,
      (SELECT COUNT(*)::int FROM devices d WHERE d.store_id = s.id AND d.status = 'IN_STOCK' AND d.created_at < now() - interval '30 days') AS stale,
      (SELECT COALESCE(SUM(si.qty), 0)::int FROM sales_order_items si JOIN sales_orders o ON o.id = si.order_id
         WHERE o.store_id = s.id AND o.status = 'COMPLETED' AND si.device_id IS NOT NULL AND o.biz_date >= ${toDate(from30)}) AS sold30
    FROM stores s WHERE s.id = ANY(${ids}) ORDER BY s.code`;
  const staleRows = await prisma.$queryRaw<{ store: string; sku: string; qty: number; oldest_days: number; cost: bigint }[]>`
    SELECT st.code || ' ' || st.name AS store, k.name AS sku, COUNT(*)::int AS qty,
           MAX(EXTRACT(DAY FROM now() - d.created_at))::int AS oldest_days, SUM(d.cost_fen)::bigint AS cost
    FROM devices d JOIN skus k ON k.id = d.sku_id JOIN stores st ON st.id = d.store_id
    WHERE d.store_id = ANY(${ids}) AND d.status = 'IN_STOCK' AND d.created_at < now() - interval '30 days'
    GROUP BY 1, 2 ORDER BY 4 DESC, 3 DESC LIMIT 15`;

  const todayRows = dayRows.filter((r) => r.date === today);
  return {
    today,
    progress,
    scope: stores.length === scopeStores.length ? (user.role === "HQ" ? "全部门店" : user.role === "REGIONAL_MANAGER" ? (user.region?.name ?? "辖区") : (stores[0]?.name ?? "")) : (stores[0]?.name ?? ""),
    stores: scopeStores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` })),
    cards: {
      todaySales: todayRows.reduce((s, r) => s + r.sales, 0),
      todayOrders: todayRows.reduce((s, r) => s + r.orders, 0),
      monthSales: monthRows.reduce((s, r) => s + r.sales, 0),
      monthProfit: monthRows.reduce((s, r) => s + r.profit, 0),
      monthDevices: monthRows.reduce((s, r) => s + r.devices, 0),
      monthTradeIns: monthRows.reduce((s, r) => s + r.tradeIns, 0),
      monthTarget: kpi.reduce((s, k) => s + (k.target?.sales ?? 0), 0),
    },
    trend,
    months,
    storeMonth,
    kpi,
    staff: staffRows.map((r) => ({ userId: r.user_id, name: r.name, store: r.store, orders: r.orders, sales: n(r.sales), profit: n(r.profit), devices: r.devices })),
    hot: hotRows.map((r) => ({ model: r.model, qty: r.qty, sales: n(r.sales) })),
    stock: stockRows.map((r) => {
      const s = stores.find((x) => x.id === r.store_id)!;
      return { storeId: r.store_id, label: `${s.code} ${s.name}`, inStock: r.in_stock, stale: r.stale, sold30: r.sold30, turnoverDays: turnoverDays(r.in_stock, r.sold30) };
    }),
    staleList: staleRows.map((r) => ({ store: r.store, sku: r.sku, qty: r.qty, oldestDays: r.oldest_days, cost: n(r.cost) })),
  };
}

export type Dashboard = NonNullable<Awaited<ReturnType<typeof getDashboard>>>;
