import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { SkuKind } from "@/generated/prisma/enums";
import { canManageProducts } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { isValidFen, MAX_AMOUNT_FEN } from "@/lib/limits";
import { skuSearchWhere } from "./search";

// 商品主数据服务层：品类、品牌、型号、SKU。查询所有角色都能用（查价），改动只有总部。

export class ProductError extends Error {}

type Actor = Pick<CurrentUser, "id" | "role">;

function assertCanManage(actor: Actor): void {
  if (!canManageProducts(actor.role)) throw new ProductError("只有总部账号能维护商品");
}

function requireText(value: unknown, label: string, max = 80): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ProductError(`${label}不能为空`);
  if (text.length > max) throw new ProductError(`${label}最多 ${max} 个字`);
  return text;
}

function optionalText(value: unknown, max = 80): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new ProductError(`最多 ${max} 个字`);
  return text || null;
}

function requireId(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ProductError(`请选择${label}`);
  return n;
}

function requireFen(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ProductError(`${label}必须是不小于 0 的金额`);
  if (!isValidFen(n)) throw new ProductError(`金额不对：${label}不能超过 ${MAX_AMOUNT_FEN / 1_000_000} 万元`);
  return n;
}

function requireKind(value: unknown): SkuKind {
  if (value === "DEVICE" || value === "ACCESSORY") return value;
  throw new ProductError("请选择大件或小件");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

// ---------- 查询 ----------

export async function listCatalog() {
  const [categories, brands, models] = await Promise.all([
    prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }] }),
    prisma.brand.findMany({ orderBy: { id: "asc" } }),
    prisma.productModel.findMany({
      orderBy: [{ brandId: "asc" }, { name: "asc" }],
      include: { brand: true, category: true, _count: { select: { skus: true } } },
    }),
  ]);
  return { categories, brands, models };
}

export type Catalog = Awaited<ReturnType<typeof listCatalog>>;
export type CatalogCategory = Catalog["categories"][number];
export type CatalogBrand = Catalog["brands"][number];
export type CatalogModel = Catalog["models"][number];

export const SKU_PAGE_SIZE = 20;

export interface SkuQuery {
  q?: string;
  categoryId?: number;
  brandId?: number;
  page?: number;
  includeInactive?: boolean;
  includeCost?: boolean; // 参考成本给店长及以上；店员拿到的是 0
}

export async function searchSkus(query: SkuQuery) {
  const page = clampPage(query.page);
  const where = {
    AND: [
      skuSearchWhere(query.q ?? ""),
      query.categoryId ? { model: { categoryId: query.categoryId } } : {},
      query.brandId ? { model: { brandId: query.brandId } } : {},
      query.includeInactive ? {} : { isActive: true },
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.sku.findMany({
      where,
      orderBy: [{ model: { brand: { name: "asc" } } }, { model: { name: "asc" } }, { name: "asc" }],
      skip: (page - 1) * SKU_PAGE_SIZE,
      take: SKU_PAGE_SIZE,
      include: { model: { include: { brand: true, category: true } } },
    }),
    prisma.sku.count({ where }),
  ]);
  return { rows: query.includeCost ? rows : rows.map((r) => ({ ...r, costPriceFen: 0 })), total, page, pageSize: SKU_PAGE_SIZE };
}

export type SkuRow = Awaited<ReturnType<typeof searchSkus>>["rows"][number];

// ---------- 品类 ----------

export interface CategoryInput {
  name: unknown;
  kind: unknown;
  sortOrder?: unknown;
}

function parseCategory(input: CategoryInput) {
  const sortOrder = input.sortOrder === null || input.sortOrder === "" ? 0 : Number(input.sortOrder ?? 0);
  // 以前填小数会悄悄存成 0，现在直接提示
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) throw new ProductError("排序要填 0 到 9999 的整数");
  return {
    name: requireText(input.name, "品类名称", 30),
    kind: requireKind(input.kind),
    sortOrder,
  };
}

export async function createCategory(actor: Actor, input: CategoryInput) {
  assertCanManage(actor);
  const data = parseCategory(input);
  try {
    const row = await prisma.category.create({ data });
    await writeAudit({ userId: actor.id, action: "category.create", entity: "category", entityId: row.id, detail: data });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductError("已经有同名品类了");
    throw error;
  }
}

export async function updateCategory(actor: Actor, id: number, input: CategoryInput) {
  assertCanManage(actor);
  const data = parseCategory(input);
  // 大件按串号管、小件按数量管，库存记法完全不同：品类下已经有型号了，就不能再改“大件 / 小件”
  const current = await prisma.category.findUnique({ where: { id }, select: { kind: true, _count: { select: { models: true } } } });
  if (!current) throw new ProductError("品类不存在");
  if (current.kind !== data.kind && current._count.models > 0) throw new ProductError("这个品类下已经有型号了，不能再改大件 / 小件；要换就新建一个品类");
  try {
    const row = await prisma.category.update({ where: { id }, data });
    await writeAudit({ userId: actor.id, action: "category.update", entity: "category", entityId: id, detail: data });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductError("已经有同名品类了");
    throw error;
  }
}

// ---------- 品牌 ----------

export async function createBrand(actor: Actor, input: { name: unknown }) {
  assertCanManage(actor);
  const name = requireText(input.name, "品牌名称", 30);
  try {
    const row = await prisma.brand.create({ data: { name } });
    await writeAudit({ userId: actor.id, action: "brand.create", entity: "brand", entityId: row.id, detail: { name } });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductError("已经有同名品牌了");
    throw error;
  }
}

export async function updateBrand(actor: Actor, id: number, input: { name: unknown }) {
  assertCanManage(actor);
  const name = requireText(input.name, "品牌名称", 30);
  try {
    const row = await prisma.brand.update({ where: { id }, data: { name } });
    await writeAudit({ userId: actor.id, action: "brand.update", entity: "brand", entityId: id, detail: { name } });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductError("已经有同名品牌了");
    throw error;
  }
}

// ---------- 型号 ----------

export interface ModelInput {
  brandId: unknown;
  categoryId: unknown;
  name: unknown;
}

function parseModel(input: ModelInput) {
  return {
    brandId: requireId(input.brandId, "品牌"),
    categoryId: requireId(input.categoryId, "品类"),
    name: requireText(input.name, "型号名称", 60),
  };
}

export async function createModel(actor: Actor, input: ModelInput) {
  assertCanManage(actor);
  const data = parseModel(input);
  try {
    const row = await prisma.productModel.create({ data });
    await writeAudit({ userId: actor.id, action: "model.create", entity: "model", entityId: row.id, detail: data });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductError("这个品牌下已经有同名型号了");
    throw error;
  }
}

export async function updateModel(actor: Actor, id: number, input: ModelInput) {
  assertCanManage(actor);
  const data = parseModel(input);
  // 型号挪到另一种（大件 / 小件）品类：已经有 SKU 的不行，否则已有的串号库存和数量库存就对不上了
  const current = await prisma.productModel.findUnique({ where: { id }, select: { category: { select: { kind: true } }, _count: { select: { skus: true } } } });
  if (!current) throw new ProductError("型号不存在");
  const target = await prisma.category.findUnique({ where: { id: data.categoryId }, select: { kind: true } });
  if (!target) throw new ProductError("品类不存在");
  if (target.kind !== current.category.kind && current._count.skus > 0) throw new ProductError("这个型号下已经有商品了，不能挪到另一种（大件 / 小件）品类");
  try {
    const row = await prisma.productModel.update({ where: { id }, data });
    await writeAudit({ userId: actor.id, action: "model.update", entity: "model", entityId: id, detail: data });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductError("这个品牌下已经有同名型号了");
    throw error;
  }
}

// ---------- SKU ----------

export interface SkuInput {
  modelId: unknown;
  name: unknown;
  color?: unknown;
  storage?: unknown;
  barcode?: unknown;
  guidePriceFen: unknown;
  costPriceFen?: unknown;
  safetyQty?: unknown;
}

function parseSku(input: SkuInput) {
  const barcode = optionalText(input.barcode, 30);
  if (barcode && !/^[A-Za-z0-9-]+$/.test(barcode)) throw new ProductError("条码只能是数字、字母和横线");
  const safetyQty = Number(input.safetyQty ?? 0);
  if (!Number.isInteger(safetyQty) || safetyQty < 0) throw new ProductError("安全库存必须是不小于 0 的整数");
  return {
    modelId: requireId(input.modelId, "型号"),
    name: requireText(input.name, "商品名称", 80),
    color: optionalText(input.color, 20),
    storage: optionalText(input.storage, 20),
    barcode,
    guidePriceFen: requireFen(input.guidePriceFen, "指导价"),
    costPriceFen: requireFen(input.costPriceFen ?? 0, "参考成本"),
    safetyQty,
  };
}

export async function createSku(actor: Actor, input: SkuInput) {
  assertCanManage(actor);
  const data = parseSku(input);
  try {
    const row = await prisma.sku.create({ data });
    await writeAudit({ userId: actor.id, action: "sku.create", entity: "sku", entityId: row.id, detail: data });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductError("条码已经被别的商品用了");
    throw error;
  }
}

export async function updateSku(actor: Actor, id: number, input: SkuInput) {
  assertCanManage(actor);
  const data = parseSku(input);
  try {
    const row = await prisma.sku.update({ where: { id }, data });
    await writeAudit({ userId: actor.id, action: "sku.update", entity: "sku", entityId: id, detail: data });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductError("条码已经被别的商品用了");
    throw error;
  }
}

export async function setSkuActive(actor: Actor, id: number, isActive: boolean) {
  assertCanManage(actor);
  const row = await prisma.sku.update({ where: { id }, data: { isActive } });
  await writeAudit({ userId: actor.id, action: isActive ? "sku.activate" : "sku.deactivate", entity: "sku", entityId: id });
  return row;
}
