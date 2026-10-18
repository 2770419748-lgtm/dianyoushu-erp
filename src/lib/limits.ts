// 数量和金额的上限。数据库里是 32 位整数（最大约 21 亿），金额按分存，等于最多约 2147 万元；
// 超过上限的输入在服务层就拒绝，提示“数量不对 / 金额不对”，不让数据库报“超出范围”变成笼统的“操作失败”。

/** 一行最多 9999 件（配件开单、采购、调拨、退货、盘点） */
export const MAX_QTY = 9999;

/** 单价、优惠、估价、一张单的合计最多 1000 万元 */
export const MAX_AMOUNT_FEN = 1_000_000_000;

/** 正整数且不超过上限；allowZero 时 0 也算合法（收货、盘点里 0 表示这次不收 / 实盘为 0） */
export function isValidQty(n: number, allowZero = false): boolean {
  return Number.isInteger(n) && n <= MAX_QTY && (allowZero ? n >= 0 : n > 0);
}

/** 不小于 0、不超过 1000 万元的整数分 */
export function isValidFen(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_AMOUNT_FEN;
}
