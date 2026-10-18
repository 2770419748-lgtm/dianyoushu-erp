import type { Prisma } from "@/generated/prisma/client";

// 商品搜索与售价的纯函数，不查库，方便单元测试。

/** 按名字、型号、品牌、条码搜 SKU；空串不加条件 */
export function skuSearchWhere(q: string): Prisma.SkuWhereInput {
  const text = q.trim();
  if (!text) return {};
  const contains = { contains: text, mode: "insensitive" as const };
  return {
    OR: [
      { name: contains },
      { barcode: contains },
      { model: { name: contains } },
      { model: { brand: { name: contains } } },
    ],
  };
}

/** 门店实际售价：有门店覆盖价用覆盖价，没有就用指导价 */
export function effectivePriceFen(guidePriceFen: number, storePriceFen: number | null | undefined): number {
  return storePriceFen ?? guidePriceFen;
}

/**
 * 机器开单的默认价：门店售价 → 指导价 → 这台的成本。
 * 回收机用“回收机（其他机型）”这种指导价 0 的通用商品时，默认价不能是 0，否则店员不改价就白送；退到成本（估价），至少不亏。
 */
export function deviceDefaultPriceFen(guidePriceFen: number, storePriceFen: number | null | undefined, costFen: number): number {
  const price = effectivePriceFen(guidePriceFen, storePriceFen);
  return price > 0 ? price : costFen;
}
