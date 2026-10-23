// 居民身份证号（18 位）校验：GB 11643 的校验位 + 出生日期是真实日期。回收登记卖家身份用（口径第 20 节）。
// 纯函数，页面和服务层都能用。

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CHARS = "10X98765432";

/** 去掉空格、小写 x 转大写 */
export function normalizeIdCard(input: string): string {
  return input.replace(/\s/g, "").toUpperCase();
}

/** 前 17 位算出来的校验位 */
export function idCardCheckChar(first17: string): string {
  const sum = WEIGHTS.reduce((s, w, i) => s + w * Number(first17[i]), 0);
  return CHECK_CHARS[sum % 11]!;
}

export function isValidIdCard(id: string): boolean {
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const y = Number(id.slice(6, 10));
  const m = Number(id.slice(10, 12));
  const d = Number(id.slice(12, 14));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  return idCardCheckChar(id.slice(0, 17)) === id[17];
}
