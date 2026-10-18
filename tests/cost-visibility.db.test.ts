import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { canSeeCost } from "@/server/auth/permissions";
import { searchSkus } from "@/server/products/product-service";
import { getDeviceByCode, listAccessoryStocks, listDevices } from "@/server/stock/stock-query";

// 成本可见性（口径第 1 节，2026-10-18 坤总选“店长及以上可见”）：机器成本、商品参考成本给店长、区域经理、总部，店员拿不到；
// 看的是服务层返回的数据，不是页面显不显示。只读，不改库。

const select = { id: true, username: true, name: true, role: true, storeId: true, regionId: true, isActive: true, store: { select: { id: true, name: true, regionId: true } }, region: { select: { id: true, name: true } } } as const;
let users: Record<"hq" | "regional" | "manager" | "staff", CurrentUser> | null = null;

beforeAll(async () => {
  try {
    const rows = await prisma.user.findMany({ where: { username: { in: ["hq", "regional", "manager", "staff"] } }, select });
    if (rows.length === 4) users = Object.fromEntries(rows.map((r) => [r.username, r as unknown as CurrentUser])) as typeof users;
  } catch {
    users = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("成本可见性（连本机库，只读）", () => {
  it("店长、区域经理、总部拿得到参考成本和机器成本，店员拿不到", async (ctx) => {
    if (!users) return ctx.skip();
    const storeId = users.manager.storeId!;
    const hqAcc = await listAccessoryStocks(users.hq, { storeId });
    if (!hqAcc.some((r) => r.sku.costPriceFen > 0)) return ctx.skip();
    const code = (await listDevices(users.hq, { storeId })).rows[0]!.code;

    for (const role of ["hq", "regional", "manager"] as const) {
      const user = users[role];
      expect(canSeeCost(user.role)).toBe(true);
      expect((await listAccessoryStocks(user, { storeId })).some((r) => r.sku.costPriceFen > 0)).toBe(true);
      const d = await getDeviceByCode(user, code);
      expect(d!.costFen).toBeGreaterThan(0);
      expect(d!.sku.costPriceFen).toBeGreaterThan(0);
      expect((await searchSkus({ page: 1, includeCost: canSeeCost(user.role) })).rows.some((r) => r.costPriceFen > 0)).toBe(true);
    }

    const staff = users.staff;
    expect(canSeeCost(staff.role)).toBe(false);
    const staffAcc = await listAccessoryStocks(staff, { storeId });
    expect(staffAcc.length).toBeGreaterThan(0);
    expect(staffAcc.every((r) => r.sku.costPriceFen === 0)).toBe(true);
    const staffDevice = await getDeviceByCode(staff, code);
    expect(staffDevice!.costFen).toBe(0);
    expect(staffDevice!.sku.costPriceFen).toBe(0);
    expect((await listDevices(staff, { storeId })).rows.every((r) => r.costFen === 0 && r.sku.costPriceFen === 0)).toBe(true);
    expect((await searchSkus({ page: 1, includeCost: canSeeCost(staff.role) })).rows.every((r) => r.costPriceFen === 0)).toBe(true);
  });
});
