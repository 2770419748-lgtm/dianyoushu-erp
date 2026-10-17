/**
 * 地址栏里的页码转成安全的整数：不是数字、小于 1 都当第 1 页；最多 10000 页。
 * 有人手拼 ?page=99999999999 时，不至于让数据库的 OFFSET 溢出报 500。
 */
export function clampPage(page: unknown): number {
  const n = Math.floor(Number(page));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10000) : 1;
}
