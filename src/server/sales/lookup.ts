import "server-only";
import { prisma } from "@/lib/prisma";
import type { DeviceStatus } from "@/generated/prisma/enums";
import { assertStoreAccess, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { canSell as deviceCanSell } from "@/server/stock/device-state";
import { deviceCodeWhere } from "@/server/stock/stock-service";
import { deviceDefaultPriceFen, effectivePriceFen } from "@/server/products/search";

// 扫码 / 输码查找（手机开单、手机查库存用）：
// 先按机器的 SN / IMEI1 / IMEI2 找，再按商品条码找配件。

export type SaleLookup =
  | { kind: "device"; deviceId: number; code: string; skuId: number; name: string; priceFen: number; status: DeviceStatus }
  | { kind: "accessory"; skuId: number; name: string; priceFen: number; stockQty: number }
  | { kind: "error"; message: string };

/** 开单用：只认本店能卖的机器、本店有货的配件 */
export async function lookupForSale(user: CurrentUser, storeId: number, rawCode: string): Promise<SaleLookup> {
  const code = rawCode.trim();
  if (!code) return { kind: "error", message: "没扫到码" };
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true } });
  if (!store) return { kind: "error", message: "门店不存在" };
  assertStoreAccess(user, store);

  const device = await prisma.device.findFirst({
    where: deviceCodeWhere(code),
    include: {
      sku: { select: { id: true, name: true, guidePriceFen: true, storePrices: { where: { storeId }, select: { priceFen: true } } } },
      store: { select: { name: true } },
      tradeInOrder: { select: { modelName: true } },
    },
  });
  if (device) {
    if (device.storeId !== storeId) return { kind: "error", message: `${device.code} 在 ${device.store.name}，不在本店` };
    if (!deviceCanSell(device.status)) return { kind: "error", message: `${device.code} 现在不能卖（状态不是在库或良品）` };
    const name = device.status === "REFURBISHED" ? `良品 · ${device.tradeInOrder?.modelName ?? device.sku.name}` : device.sku.name;
    return { kind: "device", deviceId: device.id, code: device.code, skuId: device.sku.id, name, priceFen: deviceDefaultPriceFen(device.sku.guidePriceFen, device.sku.storePrices[0]?.priceFen ?? null, device.costFen), status: device.status };
  }

  const sku = await prisma.sku.findUnique({
    where: { barcode: code },
    include: { model: { include: { category: true } }, storePrices: { where: { storeId }, select: { priceFen: true } }, accessoryStocks: { where: { storeId }, select: { qty: true } } },
  });
  if (sku) {
    if (sku.model.category.kind === "DEVICE") return { kind: "error", message: `这是 ${sku.name} 的商品条码，大件要扫机器上的串号` };
    if (sku.isService) return { kind: "error", message: `${sku.name} 是服务，在电脑开单页的“服务”里选` };
    const stockQty = sku.accessoryStocks[0]?.qty ?? 0;
    if (stockQty <= 0) return { kind: "error", message: `${sku.name} 本店没货了` };
    return { kind: "accessory", skuId: sku.id, name: sku.name, priceFen: effectivePriceFen(sku.guidePriceFen, sku.storePrices[0]?.priceFen ?? null), stockQty };
  }
  return { kind: "error", message: `没找到 ${code}：不是本店的机器，也不是配件条码` };
}

/** 查库存用：按码或名字找，范围内所有门店 */
export async function lookupStock(user: CurrentUser, rawQuery: string) {
  const q = rawQuery.trim();
  if (!q) return { devices: [], accessories: [] };
  const scope = storeScopeWhere(user);
  const [devices, accessories] = await Promise.all([
    prisma.device.findMany({
      where: {
        AND: [
          scope,
          {
            OR: [
              { code: { contains: q } },
              { sn: { contains: q } },
              { imei1: { contains: q } },
              { imei2: { contains: q } },
              { sku: { name: { contains: q, mode: "insensitive" } } },
              { sku: { model: { name: { contains: q, mode: "insensitive" } } } },
            ],
          },
          { status: { in: ["IN_STOCK", "REFURBISHED", "RECYCLED", "IN_TRANSIT", "LOCKED"] } },
        ],
      },
      orderBy: [{ storeId: "asc" }, { status: "asc" }],
      take: 50,
      include: { sku: { select: { name: true } }, store: { select: { code: true, name: true } }, tradeInOrder: { select: { modelName: true } } },
    }),
    prisma.accessoryStock.findMany({
      where: { AND: [scope, { OR: [{ sku: { name: { contains: q, mode: "insensitive" } } }, { sku: { barcode: q } }] }] },
      orderBy: [{ storeId: "asc" }],
      take: 50,
      include: { sku: { select: { name: true, safetyQty: true } }, store: { select: { code: true, name: true } } },
    }),
  ]);
  return {
    devices: devices.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.status === "REFURBISHED" || d.status === "RECYCLED" ? (d.tradeInOrder?.modelName ?? d.sku.name) : d.sku.name,
      status: d.status,
      store: `${d.store.code} ${d.store.name}`,
    })),
    accessories: accessories.map((a) => ({ id: a.id, name: a.sku.name, qty: a.qty, safetyQty: a.sku.safetyQty, store: `${a.store.code} ${a.store.name}` })),
  };
}

export type StockLookup = Awaited<ReturnType<typeof lookupStock>>;
