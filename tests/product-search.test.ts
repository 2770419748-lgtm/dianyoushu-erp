import { describe, expect, it } from "vitest";
import { effectivePriceFen, skuSearchWhere } from "@/server/products/search";
import { yuanToFen } from "@/lib/format";

describe("商品搜索条件", () => {
  it("空串不加条件", () => {
    expect(skuSearchWhere("")).toEqual({});
    expect(skuSearchWhere("   ")).toEqual({});
  });

  it("关键词同时匹配商品名、条码、型号、品牌，且不分大小写", () => {
    const where = skuSearchWhere(" mate ");
    expect(where.OR).toHaveLength(4);
    expect(where.OR?.[0]).toEqual({ name: { contains: "mate", mode: "insensitive" } });
    expect(where.OR?.[2]).toEqual({ model: { name: { contains: "mate", mode: "insensitive" } } });
  });
});

describe("门店售价", () => {
  it("有覆盖价用覆盖价，没有用指导价", () => {
    expect(effectivePriceFen(549900, null)).toBe(549900);
    expect(effectivePriceFen(549900, undefined)).toBe(549900);
    expect(effectivePriceFen(549900, 529900)).toBe(529900);
    expect(effectivePriceFen(549900, 0)).toBe(0);
  });

  it("元转分按四舍五入到分", () => {
    expect(yuanToFen(5499)).toBe(549900);
    expect(yuanToFen("5499.99")).toBe(549999);
    expect(yuanToFen(0.1 + 0.2)).toBe(30);
    expect(Number.isNaN(yuanToFen("abc"))).toBe(true);
  });
});
