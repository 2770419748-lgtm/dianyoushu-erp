import "server-only";
import { prisma } from "@/lib/prisma";
import { canManagePrices } from "@/server/auth/permissions";
import { assertStoreAccess } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { effectivePriceFen } from "./search";
import { isValidFen, MAX_AMOUNT_FEN } from "@/lib/limits";
import { ProductError } from "./product-service";

// 门店售价：按门店覆盖指导价。看价按数据范围；改价只有店长（本店）和总部。

export async function listStorePrices(user: CurrentUser, storeId: number, q = "") {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, regionId: true } });
  if (!store) throw new ProductError("门店不存在");
  assertStoreAccess(user, store);

  const text = q.trim();
  const skus = await prisma.sku.findMany({
    where: {
      isActive: true,
      ...(text
        ? {
            OR: [
              { name: { contains: text, mode: "insensitive" } },
              { model: { name: { contains: text, mode: "insensitive" } } },
              { barcode: { contains: text } },
            ],
          }
        : {}),
    },
    orderBy: [{ model: { brand: { name: "asc" } } }, { model: { name: "asc" } }, { name: "asc" }],
    include: {
      model: { include: { brand: true, category: true } },
      storePrices: { where: { storeId } },
    },
  });

  return {
    store,
    rows: skus.map((sku) => {
      const override = sku.storePrices[0]?.priceFen ?? null;
      return {
        id: sku.id,
        name: sku.name,
        modelName: sku.model.name,
        brandName: sku.model.brand.name,
        categoryName: sku.model.category.name,
        kind: sku.model.category.kind,
        barcode: sku.barcode,
        guidePriceFen: sku.guidePriceFen,
        storePriceFen: override,
        effectivePriceFen: effectivePriceFen(sku.guidePriceFen, override),
      };
    }),
  };
}

export type StorePriceRow = Awaited<ReturnType<typeof listStorePrices>>["rows"][number];

/** priceFen 传 null 表示恢复指导价（删掉覆盖记录） */
export async function setStorePrice(user: CurrentUser, storeId: number, skuId: number, priceFen: number | null) {
  if (!canManagePrices(user.role)) throw new ProductError("只有店长和总部能改门店售价");
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true } });
  if (!store) throw new ProductError("门店不存在");
  assertStoreAccess(user, store);
  const sku = await prisma.sku.findUnique({ where: { id: skuId }, select: { id: true, guidePriceFen: true } });
  if (!sku) throw new ProductError("商品不存在");

  if (priceFen === null) {
    await prisma.storePrice.deleteMany({ where: { storeId, skuId } });
    await writeAudit({ userId: user.id, action: "price.reset", entity: "sku", entityId: skuId, detail: { storeId } });
    return;
  }
  if (!Number.isInteger(priceFen) || priceFen < 0) throw new ProductError("售价必须是不小于 0 的金额");
  if (!isValidFen(priceFen)) throw new ProductError(`金额不对：售价不能超过 ${MAX_AMOUNT_FEN / 1_000_000} 万元`);
  await prisma.storePrice.upsert({
    where: { storeId_skuId: { storeId, skuId } },
    update: { priceFen },
    create: { storeId, skuId, priceFen },
  });
  await writeAudit({
    userId: user.id,
    action: "price.set",
    entity: "sku",
    entityId: skuId,
    detail: { storeId, priceFen, guidePriceFen: sku.guidePriceFen },
  });
}
