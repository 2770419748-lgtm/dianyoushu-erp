import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { libraryKey, MODEL_LIBRARY } from "@/lib/model-library";
import { addFromLibrary } from "@/server/products/library-service";
import { DEVICE_MODEL_SEED } from "../prisma/seed-data/products";

// 内置机型库（口径第 22 节，连本机库，事务回滚）：勾型号、颜色、容量建商品；已有的跳过；库里没有的型号、容量不收。

class Rollback extends Error {}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let users: { hq: CurrentUser; staff: CurrentUser } | null = null;

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

beforeAll(async () => {
  try {
    const [hq, staff] = await Promise.all([prisma.user.findFirst({ where: { role: "HQ", isActive: true } }), prisma.user.findFirst({ where: { role: "STAFF", isActive: true } })]);
    if (hq && staff) users = { hq: { ...hq, store: null, region: null } as unknown as CurrentUser, staff: { ...staff, store: null, region: null } as unknown as CurrentUser };
  } catch {
    users = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("机型库数据", () => {
  it("品牌 + 型号不重复；每个型号有颜色、容量和价格；演示数据还是原来那 50 个", () => {
    const keys = MODEL_LIBRARY.map(libraryKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of MODEL_LIBRARY) {
      expect(m.colors.length).toBeGreaterThan(0);
      expect(new Set(m.colors).size).toBe(m.colors.length);
      expect(m.variants.length).toBeGreaterThan(0);
      expect(m.variants.every((v) => v.guideYuan > 0)).toBe(true);
    }
    expect(DEVICE_MODEL_SEED).toHaveLength(50);
    expect(DEVICE_MODEL_SEED[0]!.name).toBe("Mate 70");
  });
});

describe("从机型库添加", () => {
  it("勾颜色、容量建商品；系统里已有的跳过；自己加的颜色也行", async (ctx) => {
    if (!users) return ctx.skip();
    const u = users;
    await inRolledBackTx(async (tx) => {
      await expect(addFromLibrary(u.staff, [{ brand: "一加", name: "一加 12", colors: ["岩黑"], variants: [{ storage: "12GB+256GB", guideYuan: 4299 }] }], tx)).rejects.toThrow(/总部/);
      const r = await addFromLibrary(
        u.hq,
        [
          { brand: "一加", name: "一加 12", colors: ["岩黑", "自定义色"], variants: [{ storage: "12GB+256GB", guideYuan: 3999.5 }] },
          { brand: "华为", name: "Mate 70", colors: ["曜金黑"], variants: [{ storage: "12GB+256GB", guideYuan: 1 }] }, // 演示数据里已有
        ],
        tx,
      );
      expect(r).toEqual({ created: 2, skipped: 1 });
      const skus = await tx.sku.findMany({ where: { model: { name: "一加 12" } }, orderBy: { id: "asc" }, include: { model: { include: { category: true } } } });
      expect(skus.map((s) => [s.name, s.guidePriceFen, s.model.category.name])).toEqual([
        ["一加 12 12GB+256GB 岩黑", 399950, "手机"],
        ["一加 12 12GB+256GB 自定义色", 399950, "手机"],
      ]);
      const mate = await tx.sku.findFirstOrThrow({ where: { name: "Mate 70 12GB+256GB 曜金黑" } });
      expect(mate.guidePriceFen).not.toBe(100); // 已有的不改价
    });
  });

  it("库里没有的型号、容量，没勾颜色，价格不是金额都不收", async (ctx) => {
    if (!users) return ctx.skip();
    const u = users;
    await inRolledBackTx(async (tx) => {
      await expect(addFromLibrary(u.hq, [{ brand: "一加", name: "一加 99", colors: ["黑"], variants: [{ storage: "12GB+256GB", guideYuan: 1 }] }], tx)).rejects.toThrow(/没有这个型号/);
      await expect(addFromLibrary(u.hq, [{ brand: "一加", name: "一加 12", colors: ["岩黑"], variants: [{ storage: "1TB", guideYuan: 1 }] }], tx)).rejects.toThrow(/没有 1TB/);
      await expect(addFromLibrary(u.hq, [{ brand: "一加", name: "一加 12", colors: [], variants: [{ storage: "12GB+256GB", guideYuan: 1 }] }], tx)).rejects.toThrow(/颜色/);
      await expect(addFromLibrary(u.hq, [{ brand: "一加", name: "一加 12", colors: ["岩黑"], variants: [{ storage: "12GB+256GB", guideYuan: 1.234 }] }], tx)).rejects.toThrow(/金额/);
      await expect(addFromLibrary(u.hq, [], tx)).rejects.toThrow(/先勾选/);
    });
  });
});
