import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { lookupForSale } from "@/server/sales/lookup";

// 手机开单"扫一个码加商品"的判断（只读本机库里现有的演示数据，不写任何东西）：
// 本店在库机器任一码都能认出来；别店的机器、卖掉的机器不能加；配件按条码认；店员不能查别的店。

let ready = false;
let f: {
  staff: CurrentUser;
  storeId: number;
  device: { id: number; code: string; sn: string | null; imei2: string | null };
  otherStoreDeviceCode: string | null;
  soldCode: string | null;
  accessoryBarcode: string | null;
  otherStoreId: number;
};

beforeAll(async () => {
  try {
    const staffRow = await prisma.user.findFirst({ where: { role: "STAFF", isActive: true, storeId: { not: null } }, orderBy: { id: "asc" } });
    if (!staffRow?.storeId) return;
    const storeId = staffRow.storeId;
    const [device, other, sold, accessory, otherStore] = await Promise.all([
      prisma.device.findFirst({ where: { storeId, status: "IN_STOCK" }, orderBy: { id: "asc" } }),
      prisma.device.findFirst({ where: { storeId: { not: storeId }, status: "IN_STOCK" }, orderBy: { id: "asc" } }),
      prisma.device.findFirst({ where: { storeId, status: "SOLD" }, orderBy: { id: "asc" } }),
      prisma.accessoryStock.findFirst({ where: { storeId, qty: { gt: 0 }, sku: { barcode: { not: null } } }, include: { sku: true } }),
      prisma.store.findFirst({ where: { id: { not: storeId } }, orderBy: { id: "asc" } }),
    ]);
    if (!device || !otherStore) return;
    f = {
      staff: { id: staffRow.id, username: staffRow.username, name: staffRow.name, role: staffRow.role, storeId, regionId: staffRow.regionId, mustChangePassword: false, isActive: true, store: null, region: null },
      storeId,
      device,
      otherStoreDeviceCode: other?.code ?? null,
      soldCode: sold?.code ?? null,
      accessoryBarcode: accessory?.sku.barcode ?? null,
      otherStoreId: otherStore.id,
    };
    ready = true;
  } catch {
    ready = false;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("扫码加商品：lookupForSale（只读演示数据）", () => {
  it("本店在库机器：主码、SN、IMEI2 哪个都能认出同一台", async (ctx) => {
    if (!ready) return ctx.skip();
    for (const code of [f.device.code, f.device.sn, f.device.imei2].filter((c): c is string => Boolean(c))) {
      const r = await lookupForSale(f.staff, f.storeId, code);
      expect(r.kind).toBe("device");
      if (r.kind === "device") expect(r.deviceId).toBe(f.device.id);
    }
  });

  it("别店的机器、已卖掉的机器不能加，说清楚原因", async (ctx) => {
    if (!ready) return ctx.skip();
    if (f.otherStoreDeviceCode) {
      const r = await lookupForSale(f.staff, f.storeId, f.otherStoreDeviceCode);
      expect(r.kind === "error" && r.message.includes("不在本店")).toBe(true);
    }
    if (f.soldCode) {
      const r = await lookupForSale(f.staff, f.storeId, f.soldCode);
      expect(r.kind === "error" && r.message.includes("不能卖")).toBe(true);
    }
  });

  it("配件按商品条码认；查不到的码给出提示", async (ctx) => {
    if (!ready) return ctx.skip();
    if (f.accessoryBarcode) {
      const r = await lookupForSale(f.staff, f.storeId, f.accessoryBarcode);
      expect(r.kind).toBe("accessory");
    }
    const none = await lookupForSale(f.staff, f.storeId, "NO-SUCH-CODE-000");
    expect(none.kind).toBe("error");
  });

  it("店员拿别的门店去查：直接拒绝", async (ctx) => {
    if (!ready) return ctx.skip();
    await expect(lookupForSale(f.staff, f.otherStoreId, f.device.code)).rejects.toBeInstanceOf(PermissionError);
  });
});
