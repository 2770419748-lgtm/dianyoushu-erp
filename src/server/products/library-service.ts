import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { isValidFen } from "@/lib/limits";
import { nameKey } from "@/lib/import/specs";
import { libraryKey, MODEL_LIBRARY } from "@/lib/model-library";
import { canManageProducts } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { createSkus, lockImportKind } from "@/server/import/import-service";
import { ProductError } from "./product-service";

// 从内置机型库添加商品（口径第 22 节）：总部勾型号、颜色、容量，改指导价，一次建好。
// 系统里已有同品牌同型号同颜色同容量的跳过；品牌、型号没有就建（建在机型库写的品类“手机”或“平板”下）。

export interface LibraryPick {
  brand: string;
  name: string;
  colors: string[];
  variants: { storage: string; guideYuan: number }[];
}

/** 一次最多建这么多个商品 */
const MAX_SKUS_PER_ADD = 2000;

/** 系统里已有的商品（品牌|型号|颜色|容量 的键），页面上把已有的组合标出来 */
export async function existingSkuKeys(): Promise<string[]> {
  const skus = await prisma.sku.findMany({ select: { color: true, storage: true, model: { select: { name: true, brand: { select: { name: true } } } } } });
  return skus.map((s) => nameKey(s.model.brand.name, s.model.name, s.color, s.storage));
}

export async function addFromLibrary(user: CurrentUser, picks: unknown, db?: Prisma.TransactionClient): Promise<{ created: number; skipped: number }> {
  if (!canManageProducts(user.role)) throw new ProductError("只有总部账号能维护商品");
  if (!Array.isArray(picks) || picks.length === 0) throw new ProductError("先勾选要添加的型号");
  const byKey = new Map(MODEL_LIBRARY.map((m) => [libraryKey(m), m]));
  const items: { brand: string; model: string; category: string; color: string; storage: string; guide: number }[] = [];
  for (const raw of picks as LibraryPick[]) {
    const lib = byKey.get(libraryKey({ brand: String(raw?.brand ?? ""), name: String(raw?.name ?? "") }));
    if (!lib) throw new ProductError("机型库里没有这个型号，刷新页面再试");
    const colors = [...new Set((Array.isArray(raw.colors) ? raw.colors : []).map((c) => String(c).trim()).filter(Boolean))];
    if (colors.length === 0) throw new ProductError(`${lib.name}：至少勾一个颜色`);
    if (colors.some((c) => c.length > 20)) throw new ProductError(`${lib.name}：颜色名最多 20 个字`);
    const variants = Array.isArray(raw.variants) ? raw.variants : [];
    if (variants.length === 0) throw new ProductError(`${lib.name}：至少勾一个容量`);
    const seenStorage = new Set<string>();
    for (const v of variants) {
      const storage = String(v?.storage ?? "");
      if (!lib.variants.some((x) => x.storage === storage)) throw new ProductError(`${lib.name}：机型库里没有 ${storage} 这个容量`);
      if (seenStorage.has(storage)) throw new ProductError(`${lib.name}：${storage} 勾了两次`);
      seenStorage.add(storage);
      const guide = Math.round(Number(v?.guideYuan) * 100);
      if (!Number.isFinite(Number(v?.guideYuan)) || !isValidFen(guide) || Math.abs(Number(v.guideYuan) * 100 - guide) > 1e-6) throw new ProductError(`${lib.name} ${storage}：指导价要填金额（元，最多两位小数）`);
      for (const color of colors) items.push({ brand: lib.brand, model: lib.name, category: lib.category, color, storage, guide });
    }
  }
  if (items.length > MAX_SKUS_PER_ADD) throw new ProductError(`一次最多添加 ${MAX_SKUS_PER_ADD} 个商品，分几次加`);

  const run = async (tx: Prisma.TransactionClient) => {
    await lockImportKind(tx, "PRODUCTS"); // 和商品导入共用一把锁：同时点两次不建出重复商品（复查第 74 条）
    const categories = await tx.category.findMany({ where: { name: { in: ["手机", "平板"] }, isActive: true }, select: { id: true, name: true, kind: true } });
    const categoryId = new Map(categories.filter((c) => c.kind === "DEVICE").map((c) => [c.name, c.id]));
    for (const c of new Set(items.map((i) => i.category))) {
      if (!categoryId.has(c)) throw new ProductError(`系统里没有大件品类“${c}”（或者停用了），先在“品类与品牌”里建`);
    }
    // 型号已经建在别的品类下：不挪品类
    const models = await tx.productModel.findMany({ select: { name: true, categoryId: true, brand: { select: { name: true } }, category: { select: { name: true } } } });
    const modelCategory = new Map(models.map((m) => [nameKey(m.brand.name, m.name), m]));
    for (const it of items) {
      const m = modelCategory.get(nameKey(it.brand, it.model));
      if (m && m.categoryId !== categoryId.get(it.category)) throw new ProductError(`型号“${it.model}”系统里已经在“${m.category.name}”下`);
    }
    const skus = await tx.sku.findMany({ select: { color: true, storage: true, model: { select: { name: true, brand: { select: { name: true } } } } } });
    const existing = new Set(skus.map((s) => nameKey(s.model.brand.name, s.model.name, s.color, s.storage)));
    const fresh = items.filter((i) => !existing.has(nameKey(i.brand, i.model, i.color, i.storage)));
    const created = await createSkus(
      tx,
      fresh.map((i) => ({ brand: i.brand, model: i.model, categoryId: categoryId.get(i.category)!, color: i.color, storage: i.storage, barcode: null, guide: i.guide, cost: 0, safety: 0 })),
    );
    await writeAudit({ userId: user.id, action: "sku.library_add", entity: "sku", detail: { models: [...new Set(items.map((i) => `${i.brand} ${i.model}`))], created, skipped: items.length - fresh.length } }, tx);
    return { created, skipped: items.length - fresh.length };
  };
  return db ? run(db) : prisma.$transaction(run, { timeout: 60_000 });
}
