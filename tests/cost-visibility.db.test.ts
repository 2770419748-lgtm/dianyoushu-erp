import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { getDeviceByCode, listAccessoryStocks, listDevices } from "@/server/stock/stock-query";

// 成本可见性（口径第 1 节，2026-10-18 深审）：机器成本给店长以上，商品参考成本只给总部；
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
  it("参考成本只有总部拿得到；机器成本店长、区域经理拿得到，店员拿不到", async (ctx) => {
    if (!users) return ctx.skip();
    const storeId = users.manager.storeId!;
    const hqAcc = await listAccessoryStocks(users.hq, { storeId });
    if (!hqAcc.some((r) => r.sku.costPriceFen > 0)) return ctx.skip();
    for (const role of ["regional", "manager", "staff"] as const) {
      const rows = await listAccessoryStocks(users[role], { storeId });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.sku.costPriceFen === 0)).toBe(true);
    }

    const hqDevices = await listDevices(users.hq, { storeId });
    const code = hqDevices.rows[0]!.code;
    expect(hqDevices.rows[0]!.costFen).toBeGreaterThan(0);
    for (const role of ["regional", "manager"] as const) {
      const d = await getDeviceByCode(users[role], code);
      expect(d!.costFen).toBeGreaterThan(0);
      expect(d!.sku.costPriceFen).toBe(0);
      const list = await listDevices(users[role], { storeId });
      expect(list.rows.every((r) => r.sku.costPriceFen === 0)).toBe(true);
    }
    const staffView = await getDeviceByCode(users.staff, code);
    expect(staffView!.costFen).toBe(0);
    expect(staffView!.sku.costPriceFen).toBe(0);
  });
});
