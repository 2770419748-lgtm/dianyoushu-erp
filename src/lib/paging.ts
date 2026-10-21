/**
 * 地址栏里的页码转成安全的整数：不是数字、小于 1 都当第 1 页；最多 10000 页。
 * 有人手拼 ?page=99999999999 时，不至于让数据库的 OFFSET 溢出报 500。
 */
export function clampPage(page: unknown): number {
  const n = Math.floor(Number(page));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10000) : 1;
}

/** 数据库 id 是 32 位整数：地址里的 id 不是正整数、或者超过 2147483647（/notices/99999999999），都按“不存在”处理，别让查询溢出报 500 */
export const MAX_DB_ID = 2147483647;
export function isDbId(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= MAX_DB_ID;
}
