// 看板指标的纯函数（口径第 9 节），不查库，方便单元测试。

export interface DayStoreRow {
  storeId: number;
  date: string; // YYYY-MM-DD
  sales: number; // 销售额（分）= 应收 − 退款
  profit: number; // 毛利（分）
  orders: number;
  devices: number; // 主机量
  tradeIns: number;
}

/** 时间进度：销售数据截止日的日序号 ÷ 当月自然日总数（店有数口径） */
export function timeProgress(cutoff: string): number {
  const [y, m, d] = cutoff.split("-").map(Number) as [number, number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d / days;
}

export function daysInMonth(cutoff: string): number {
  const [y, m] = cutoff.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * 门店日均差额（口径第 9 节）：后面每天要卖多少才能完成 − 到现在的日均实际。
 * 正数 = 后面每天要比现在多卖这么多；负数 = 照现在的速度能超额完成。
 */
export function dailyGap(target: number, actual: number, cutoff: string): { needPerDay: number; actualPerDay: number; gap: number; remainingDays: number } {
  const [, , d] = cutoff.split("-").map(Number) as [number, number, number];
  const total = daysInMonth(cutoff);
  const remainingDays = total - d;
  const actualPerDay = d > 0 ? actual / d : 0;
  const needPerDay = remainingDays > 0 ? Math.max(target - actual, 0) / remainingDays : 0;
  return { needPerDay, actualPerDay, gap: remainingDays > 0 ? needPerDay - actualPerDay : 0, remainingDays };
}

/** 库存周转天数：在库数 ÷ 近 30 天日均销量；没卖过的记为无穷（显示"滞销"） */
export function turnoverDays(inStock: number, sold30: number): number | null {
  if (sold30 <= 0) return inStock > 0 ? null : 0;
  return inStock / (sold30 / 30);
}

/** 把门店 × 天的明细按天合计（选"全部门店"时的趋势线） */
export function sumByDate(rows: DayStoreRow[]): Map<string, Omit<DayStoreRow, "storeId" | "date">> {
  const map = new Map<string, Omit<DayStoreRow, "storeId" | "date">>();
  for (const r of rows) {
    const cur = map.get(r.date) ?? { sales: 0, profit: 0, orders: 0, devices: 0, tradeIns: 0 };
    cur.sales += r.sales;
    cur.profit += r.profit;
    cur.orders += r.orders;
    cur.devices += r.devices;
    cur.tradeIns += r.tradeIns;
    map.set(r.date, cur);
  }
  return map;
}
