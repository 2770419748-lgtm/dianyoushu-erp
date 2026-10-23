import "server-only";
import { randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { isValidFen, MAX_AMOUNT_FEN } from "@/lib/limits";
import { looksLikeScientific, positiveInt, TableError, toRecords, yuanToFen, type TableRow } from "@/lib/import/table";
import {
  ACCESSORY_COLUMNS,
  CUSTOMER_COLUMNS,
  DEVICE_COLUMNS,
  IMPORT_COLUMNS,
  IMPORT_KIND_LABELS,
  OPENING_KINDS,
  PRODUCT_COLUMNS,
  REVOCABLE_KINDS,
  skuDisplayName,
  STORE_COLUMNS,
  USER_COLUMNS,
  type ImportKindKey,
} from "@/lib/import/specs";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { hashPassword } from "@/server/auth/password";
import { ROLE_LABELS } from "@/server/auth/permissions";
import { phoneColumns, phoneFingerprint } from "@/server/pii/crypto";
import { assertStoreQuota, lockStoreQuota, OrgError } from "@/server/org/org-service";
import { nextDocNo } from "@/server/stock/doc-no";
import { isValidImei, isValidSn } from "@/server/stock/imei";
import { changeAccessoryStock, openingReceiveDevices, revokeOpeningStock, StockError } from "@/server/stock/stock-service";
import { WECOM_USERID_PATTERN } from "@/server/wecom/config";
import { readUpload } from "./read-file";

// 数据导入（口径第 22 节）：上传 → 预检（不写库，所有问题一次列出来）→ 确认导入（事务里再查一遍，有问题整批不进）。
// 每类导入的检查都在 analyze* 里：返回问题清单、给页面看的汇总，和一个“写库”的函数（只在确认导入时、同一个事务里调）。
// 在库机器、配件期初生成期初入库单（单号 QC…，也是库存流水的单号）；还没开过销售单之前，期初入库单和客户导入可以整批撤销。

export class ImportError extends Error {}

type Db = Prisma.TransactionClient;

export interface ImportProblem {
  line: number; // 文件里的行号（表头是第 1 行）；0 = 整张表的问题
  column: string;
  message: string;
}

export interface ImportCheck {
  kind: ImportKindKey;
  rowCount: number;
  problems: ImportProblem[]; // 最多 MAX_PROBLEMS 条
  problemCount: number;
  summary: string[];
  createCount: number;
  skipCount: number;
}

export interface ImportDone {
  batchId: number;
  batchNo: string;
  created: number;
  skipped: number;
  summary: string[];
  passwords?: { username: string; name: string; password: string }[]; // 员工导入：初始密码只返回这一次
}

const MAX_PROBLEMS = 200;
/** 员工一次最多导这么多（每个人要算一次密码哈希，几千个会很慢） */
const MAX_USER_ROWS = 500;

interface Analysis {
  problems: ImportProblem[];
  summary: string[];
  createCount: number;
  skipCount: number;
  apply: (tx: Db, ctx: ApplyContext) => Promise<{ created: number; extra?: Partial<ImportDone> }>;
}

interface ApplyContext {
  batchId: number;
  batchNo: string;
  operatorId: number;
  passwordHashes: string[]; // 员工导入：和行一一对应，事务外先算好
  passwords: string[];
}

function assertHq(user: Pick<CurrentUser, "role">) {
  if (user.role !== "HQ") throw new ImportError("只有总部能导入数据");
}

/** 名字比较：去掉所有空白、不分大小写（“iPhone 16 Pro” 和 “iphone16pro” 当成一样） */
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toLowerCase();

class Collector {
  list: ImportProblem[] = [];
  add(line: number, column: string, message: string) {
    this.list.push({ line, column, message });
  }
  get count() {
    return this.list.length;
  }
}

function checkLength(p: Collector, row: TableRow<string>, key: string, label: string, max: number, required: boolean): string | null {
  const v = row.values[key] ?? "";
  if (!v) {
    if (required) p.add(row.line, label, "没填");
    return null;
  }
  if (v.length > max) {
    p.add(row.line, label, `最多 ${max} 个字`);
    return null;
  }
  return v;
}

function checkMoney(p: Collector, row: TableRow<string>, key: string, label: string, required: boolean): number | null {
  const fen = yuanToFen(row.values[key] ?? "");
  if (fen === null) {
    if (required) p.add(row.line, label, "没填");
    return null;
  }
  if (Number.isNaN(fen)) p.add(row.line, label, `“${row.values[key]}”不是金额（元，最多两位小数）`);
  else if (!isValidFen(fen)) p.add(row.line, label, `太大了，最多 ${MAX_AMOUNT_FEN / 100} 元`);
  else return fen;
  return null;
}

/** 同一列在表里重复：记下第一次出现的行号，后面的报“和第 N 行重复” */
function dupChecker(p: Collector, label: string) {
  const seen = new Map<string, number>();
  return (row: TableRow<string>, key: string, shown = key) => {
    const first = seen.get(key);
    if (first !== undefined) {
      p.add(row.line, label, `“${shown}”和第 ${first} 行重复`);
      return true;
    }
    seen.set(key, row.line);
    return false;
  };
}

function countBy<T>(items: T[], key: (t: T) => string): string {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].map(([k, n]) => `${k} ${n}`).join("，");
}

// ---------- 门店 ----------

async function analyzeStores(rows: TableRow<(typeof STORE_COLUMNS)[number]["key"]>[], db: Db): Promise<Analysis> {
  const p = new Collector();
  const dup = dupChecker(p, "门店编码");
  const [regions, stores] = await Promise.all([db.region.findMany({ select: { id: true, name: true } }), db.store.findMany({ select: { code: true, name: true } })]);
  const regionByName = new Map(regions.map((r) => [norm(r.name), r]));
  const storeByCode = new Map(stores.map((s) => [s.code, s]));
  const plan: { line: number; region: string; code: string; name: string; address: string | null }[] = [];
  for (const row of rows) {
    const before = p.count;
    const region = checkLength(p, row, "region", "区域", 50, true);
    const rawCode = checkLength(p, row, "code", "门店编码", 20, true);
    const code = rawCode?.toUpperCase() ?? null;
    if (code && !/^[A-Z0-9-]+$/.test(code)) p.add(row.line, "门店编码", "只能用字母、数字和横线，如 S001");
    else if (code && storeByCode.has(code)) p.add(row.line, "门店编码", `系统里已经有 ${code}（${storeByCode.get(code)!.name}）`);
    else if (code) dup(row, code);
    const name = checkLength(p, row, "name", "门店名称", 50, true);
    const address = checkLength(p, row, "address", "地址", 200, false);
    if (p.count === before) plan.push({ line: row.line, region: region!, code: code!, name: name!, address });
  }
  // 门店数上限（口径第 21 节）：在用的加上这次新建的不能超
  try {
    await assertStoreQuota(db, DEMO_MODE, rows.length);
  } catch (error) {
    if (!(error instanceof OrgError)) throw error;
    p.add(0, "门店", error.message);
  }
  const newRegions = [...new Set(plan.map((s) => s.region).filter((r) => !regionByName.has(norm(r))))];
  return {
    problems: p.list,
    summary: [`新建门店 ${plan.length} 家`, ...(newRegions.length ? [`新建区域：${newRegions.join("、")}`] : [])],
    createCount: plan.length,
    skipCount: 0,
    apply: async (tx) => {
      const regionIds = new Map(regions.map((r) => [norm(r.name), r.id]));
      for (const name of newRegions) {
        const r = await tx.region.create({ data: { name } });
        regionIds.set(norm(name), r.id);
      }
      await tx.store.createMany({ data: plan.map((s) => ({ code: s.code, name: s.name, address: s.address, regionId: regionIds.get(norm(s.region))! })) });
      return { created: plan.length };
    },
  };
}

// ---------- 员工 ----------

const ROLE_BY_LABEL = new Map<string, Role>(Object.entries(ROLE_LABELS).flatMap(([role, label]) => [[label, role as Role], [role.toLowerCase(), role as Role]]));

async function analyzeUsers(rows: TableRow<(typeof USER_COLUMNS)[number]["key"]>[], db: Db): Promise<Analysis> {
  const p = new Collector();
  if (rows.length > MAX_USER_ROWS) p.add(0, "员工", `员工一次最多导 ${MAX_USER_ROWS} 个，分成几个文件导`);
  const dupName = dupChecker(p, "账号");
  const dupWecom = dupChecker(p, "企业微信账号");
  const [users, stores, regions] = await Promise.all([
    db.user.findMany({ select: { username: true, wecomUserid: true } }),
    db.store.findMany({ select: { id: true, code: true, isActive: true } }),
    db.region.findMany({ select: { id: true, name: true, isActive: true } }),
  ]);
  const takenNames = new Set(users.map((u) => u.username));
  const takenWecom = new Set(users.flatMap((u) => (u.wecomUserid ? [u.wecomUserid] : [])));
  const storeByCode = new Map(stores.map((s) => [s.code, s]));
  const regionByName = new Map(regions.map((r) => [norm(r.name), r]));
  const plan: { line: number; username: string; name: string; role: Role; storeId: number | null; regionId: number | null; wecomUserid: string | null }[] = [];
  for (const row of rows) {
    const before = p.count;
    const username = checkLength(p, row, "username", "账号", 30, true)?.toLowerCase() ?? null;
    if (username && !/^[a-z0-9_]{3,30}$/.test(username)) p.add(row.line, "账号", "只能用小写字母、数字、下划线，3 到 30 位");
    else if (username && takenNames.has(username)) p.add(row.line, "账号", `系统里已经有 ${username}`);
    else if (username) dupName(row, username);
    const name = checkLength(p, row, "name", "姓名", 30, true);
    const roleText = row.values.role;
    const role = ROLE_BY_LABEL.get(roleText) ?? ROLE_BY_LABEL.get(roleText.toLowerCase()) ?? null;
    if (!roleText) p.add(row.line, "角色", "没填");
    else if (!role) p.add(row.line, "角色", `“${roleText}”不认识，填总部、区域经理、店长或店员`);
    let storeId: number | null = null;
    let regionId: number | null = null;
    if (role === "STAFF" || role === "STORE_MANAGER") {
      const code = row.values.storeCode.toUpperCase();
      const store = storeByCode.get(code);
      if (!code) p.add(row.line, "门店编码", "店长、店员要填门店编码");
      else if (!store) p.add(row.line, "门店编码", `系统里没有门店 ${code}（先导门店）`);
      else if (!store.isActive) p.add(row.line, "门店编码", `门店 ${code} 已停用`);
      else storeId = store.id;
    } else if (role === "REGIONAL_MANAGER") {
      const region = regionByName.get(norm(row.values.region));
      if (!row.values.region) p.add(row.line, "区域", "区域经理要填区域");
      else if (!region) p.add(row.line, "区域", `系统里没有区域“${row.values.region}”（先导门店，会一起建区域）`);
      else if (!region.isActive) p.add(row.line, "区域", `区域“${row.values.region}”已停用`);
      else regionId = region.id;
    }
    const wecom = row.values.wecomUserid || null;
    if (wecom && !WECOM_USERID_PATTERN.test(wecom)) p.add(row.line, "企业微信账号", "格式不对（字母、数字和 _ . @ -）");
    else if (wecom && takenWecom.has(wecom)) p.add(row.line, "企业微信账号", `系统里已经有人用了 ${wecom}`);
    else if (wecom) dupWecom(row, wecom);
    if (p.count === before) plan.push({ line: row.line, username: username!, name: name!, role: role!, storeId, regionId, wecomUserid: wecom });
  }
  return {
    problems: p.list,
    summary: [`新建员工 ${plan.length} 个：${countBy(plan, (u) => ROLE_LABELS[u.role])}`, "初始密码系统随机生成，导入后只显示这一次；第一次登录先改密码"],
    createCount: plan.length,
    skipCount: 0,
    apply: async (tx, ctx) => {
      await tx.user.createMany({
        data: plan.map((u, i) => ({ username: u.username, name: u.name, role: u.role, storeId: u.storeId, regionId: u.regionId, wecomUserid: u.wecomUserid, passwordHash: ctx.passwordHashes[i]!, mustChangePassword: true })),
      });
      return { created: plan.length, extra: { passwords: plan.map((u, i) => ({ username: u.username, name: u.name, password: ctx.passwords[i]! })) } };
    },
  };
}

// ---------- 商品 ----------

async function analyzeProducts(rows: TableRow<(typeof PRODUCT_COLUMNS)[number]["key"]>[], db: Db): Promise<Analysis> {
  const p = new Collector();
  const dupBarcode = dupChecker(p, "条码");
  const dupSku = dupChecker(p, "型号");
  const [categories, brands, models, skus] = await Promise.all([
    db.category.findMany({ select: { id: true, name: true, kind: true, isActive: true } }),
    db.brand.findMany({ select: { id: true, name: true } }),
    db.productModel.findMany({ select: { id: true, name: true, brandId: true, categoryId: true, category: { select: { name: true } } } }),
    db.sku.findMany({ select: { barcode: true, name: true, color: true, storage: true, model: { select: { name: true, brand: { select: { name: true } } } } } }),
  ]);
  const categoryByName = new Map(categories.map((c) => [norm(c.name), c]));
  const brandByName = new Map(brands.map((b) => [norm(b.name), b]));
  const modelByKey = new Map(models.map((m) => [`${m.brandId}|${norm(m.name)}`, m]));
  const skuByBarcode = new Map(skus.flatMap((s) => (s.barcode ? [[s.barcode, s] as const] : [])));
  const keyOf = (brand: string, model: string, color: string | null, storage: string | null) => `${norm(brand)}|${norm(model)}|${norm(color)}|${norm(storage)}`;
  const existingKeys = new Set(skus.map((s) => keyOf(s.model.brand.name, s.model.name, s.color, s.storage)));
  const modelCategoryInFile = new Map<string, { category: string; line: number }>();
  const plan: { brand: string; model: string; categoryId: number; color: string | null; storage: string | null; barcode: string | null; guide: number; cost: number; safety: number }[] = [];
  let skipped = 0;
  for (const row of rows) {
    const before = p.count;
    const categoryText = checkLength(p, row, "category", "品类", 30, true);
    const category = categoryText ? categoryByName.get(norm(categoryText)) : undefined;
    if (categoryText && !category) p.add(row.line, "品类", `系统里没有品类“${categoryText}”（已有：${categories.map((c) => c.name).join("、")}）`);
    else if (category && !category.isActive) p.add(row.line, "品类", `品类“${category.name}”已停用`);
    else if (category && category.name === "服务") p.add(row.line, "品类", "碎屏险、延保这类服务商品在商品页建，不从这里导");
    const brand = checkLength(p, row, "brand", "品牌", 80, true);
    const model = checkLength(p, row, "model", "型号", 80, true);
    const color = checkLength(p, row, "color", "颜色", 20, false);
    const storage = checkLength(p, row, "storage", "容量", 20, false);
    const barcode = checkLength(p, row, "barcode", "条码", 30, false);
    if (barcode && looksLikeScientific(barcode)) p.add(row.line, "条码", "被 Excel 改成了科学计数法，后几位已经丢了：把这一列设成文本、重新填");
    else if (barcode && !/^[A-Za-z0-9-]+$/.test(barcode)) p.add(row.line, "条码", "只能是数字、字母和横线");
    const guide = checkMoney(p, row, "guide", "指导价", true);
    const cost = checkMoney(p, row, "cost", "参考成本", false);
    const safetyText = row.values.safety;
    const safety = safetyText ? positiveInt(safetyText) : 0;
    if (safetyText && safetyText !== "0" && (safety === null || Number.isNaN(safety))) p.add(row.line, "安全库存", "要填整数");
    if (p.count > before || !brand || !model || !category) continue;
    // 型号已经在别的品类下（系统里，或者表里前面的行）
    const existingBrand = brandByName.get(norm(brand));
    const existingModel = existingBrand ? modelByKey.get(`${existingBrand.id}|${norm(model)}`) : undefined;
    if (existingModel && existingModel.categoryId !== category.id) {
      p.add(row.line, "品类", `型号“${model}”系统里已经在“${existingModel.category.name}”下`);
      continue;
    }
    const inFile = modelCategoryInFile.get(`${norm(brand)}|${norm(model)}`);
    if (inFile && inFile.category !== category.name) {
      p.add(row.line, "品类", `同一个型号第 ${inFile.line} 行写的是“${inFile.category}”`);
      continue;
    }
    modelCategoryInFile.set(`${norm(brand)}|${norm(model)}`, { category: category.name, line: row.line });
    const key = keyOf(brand, model, color, storage);
    const shown = skuDisplayName(model, storage, color);
    if (barcode) {
      const owner = skuByBarcode.get(barcode);
      if (owner && keyOf(owner.model.brand.name, owner.model.name, owner.color, owner.storage) !== key) {
        p.add(row.line, "条码", `条码已经被“${owner.name}”用了`);
        continue;
      }
      if (dupBarcode(row, barcode)) continue;
      if (owner) {
        skipped++;
        continue;
      }
    }
    if (dupSku(row, key, shown)) continue;
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }
    plan.push({ brand, model, categoryId: category.id, color, storage, barcode, guide: guide!, cost: cost ?? 0, safety: safety && !Number.isNaN(safety) ? safety : 0 });
  }
  const newModels = new Set(plan.map((s) => `${norm(s.brand)}|${norm(s.model)}`));
  return {
    problems: p.list,
    summary: [`新建商品 ${plan.length} 个（${newModels.size} 个型号）`, ...(skipped ? [`系统里已有 ${skipped} 个，跳过（价格不改，改价去商品页）`] : [])],
    createCount: plan.length,
    skipCount: skipped,
    apply: async (tx) => {
      const created = await createSkus(tx, plan);
      return { created };
    },
  };
}

/** 按品牌名、型号名建商品（品牌、型号没有就建）。数据导入和机型库添加共用 */
export async function createSkus(
  tx: Db,
  items: { brand: string; model: string; categoryId: number; color: string | null; storage: string | null; barcode: string | null; guide: number; cost: number; safety: number }[],
): Promise<number> {
  const brandIds = new Map((await tx.brand.findMany({ select: { id: true, name: true } })).map((b) => [norm(b.name), b.id]));
  const modelIds = new Map((await tx.productModel.findMany({ select: { id: true, name: true, brandId: true } })).map((m) => [`${m.brandId}|${norm(m.name)}`, m.id]));
  const data: Prisma.SkuCreateManyInput[] = [];
  for (const it of items) {
    let brandId = brandIds.get(norm(it.brand));
    if (brandId === undefined) {
      brandId = (await tx.brand.create({ data: { name: it.brand.trim() } })).id;
      brandIds.set(norm(it.brand), brandId);
    }
    let modelId = modelIds.get(`${brandId}|${norm(it.model)}`);
    if (modelId === undefined) {
      modelId = (await tx.productModel.create({ data: { brandId, categoryId: it.categoryId, name: it.model.trim() } })).id;
      modelIds.set(`${brandId}|${norm(it.model)}`, modelId);
    }
    data.push({ modelId, name: skuDisplayName(it.model.trim(), it.storage, it.color), color: it.color, storage: it.storage, barcode: it.barcode, guidePriceFen: it.guide, costPriceFen: it.cost, safetyQty: it.safety });
  }
  try {
    const r = await tx.sku.createMany({ data });
    return r.count;
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new ImportError("有条码刚被别的商品用了，重新上传预检一次");
    throw error;
  }
}

// ---------- 在库机器、配件期初：找商品 ----------

interface SkuLookup {
  id: number;
  name: string;
  isActive: boolean;
  isService: boolean;
  kind: "DEVICE" | "ACCESSORY";
}

async function skuResolver(db: Db) {
  const skus = await db.sku.findMany({
    select: { id: true, name: true, color: true, storage: true, barcode: true, isActive: true, isService: true, model: { select: { name: true, brand: { select: { name: true } }, category: { select: { kind: true } } } } },
  });
  const byBarcode = new Map<string, SkuLookup>();
  const byFull = new Map<string, SkuLookup[]>(); // 品牌|型号|颜色|容量
  const byNoStorage = new Map<string, SkuLookup[]>(); // 品牌|型号|颜色（配件不看容量）
  for (const s of skus) {
    const it: SkuLookup = { id: s.id, name: s.name, isActive: s.isActive, isService: s.isService, kind: s.model.category.kind };
    if (s.barcode) byBarcode.set(s.barcode, it);
    const full = `${norm(s.model.brand.name)}|${norm(s.model.name)}|${norm(s.color)}|${norm(s.storage)}`;
    byFull.set(full, [...(byFull.get(full) ?? []), it]);
    const short = `${norm(s.model.brand.name)}|${norm(s.model.name)}|${norm(s.color)}`;
    byNoStorage.set(short, [...(byNoStorage.get(short) ?? []), it]);
  }
  return (p: Collector, row: TableRow<string>, kind: "DEVICE" | "ACCESSORY"): SkuLookup | null => {
    const v = row.values;
    let found: SkuLookup[];
    if (v.barcode) {
      const hit = byBarcode.get(v.barcode);
      if (!hit) {
        p.add(row.line, "条码", looksLikeScientific(v.barcode) ? "被 Excel 改成了科学计数法，后几位已经丢了：把这一列设成文本、重新填" : `系统里没有条码 ${v.barcode} 的商品`);
        return null;
      }
      found = [hit];
    } else {
      if (!v.brand || !v.model) {
        p.add(row.line, "商品", kind === "DEVICE" ? "填条码，或者填品牌、型号、颜色、容量" : "填条码，或者填品牌、商品名");
        return null;
      }
      found = kind === "DEVICE" ? (byFull.get(`${norm(v.brand)}|${norm(v.model)}|${norm(v.color)}|${norm(v.storage)}`) ?? []) : (byNoStorage.get(`${norm(v.brand)}|${norm(v.model)}|${norm(v.color)}`) ?? []);
      const label = skuDisplayName(`${v.brand} ${v.model}`, kind === "DEVICE" ? v.storage || null : null, v.color || null);
      if (found.length === 0) {
        p.add(row.line, "商品", `系统里没有“${label}”：先导商品，或者从机型库添加${kind === "DEVICE" ? "（颜色、容量也要一样）" : ""}`);
        return null;
      }
      if (found.length > 1) {
        p.add(row.line, "商品", `有 ${found.length} 个“${label}”，填条码区分`);
        return null;
      }
    }
    const sku = found[0]!;
    if (sku.kind !== kind) p.add(row.line, "商品", `“${sku.name}”是${sku.kind === "DEVICE" ? "大件（按台管，导在库机器）" : "小件（按数量管，导配件期初）"}`);
    else if (sku.isService) p.add(row.line, "商品", `“${sku.name}”是服务商品，没有库存`);
    else if (!sku.isActive) p.add(row.line, "商品", `“${sku.name}”已停用`);
    else return sku;
    return null;
  };
}

async function storeResolver(db: Db) {
  const stores = await db.store.findMany({ select: { id: true, code: true, name: true, isActive: true } });
  const byCode = new Map(stores.map((s) => [s.code, s]));
  return (p: Collector, row: TableRow<string>) => {
    const code = row.values.storeCode.toUpperCase();
    const store = byCode.get(code);
    if (!code) p.add(row.line, "门店编码", "没填");
    else if (!store) p.add(row.line, "门店编码", `系统里没有门店 ${code}（先导门店）`);
    else if (!store.isActive) p.add(row.line, "门店编码", `门店 ${code} 已停用`);
    else return store;
    return null;
  };
}

// ---------- 在库机器 ----------

async function analyzeDevices(rows: TableRow<(typeof DEVICE_COLUMNS)[number]["key"]>[], db: Db): Promise<Analysis> {
  const p = new Collector();
  const dup = dupChecker(p, "码");
  const [findStore, findSku] = await Promise.all([storeResolver(db), skuResolver(db)]);
  const plan: { line: number; storeId: number; storeName: string; skuId: number; codes: { sn: string | null; imei1: string | null; imei2: string | null }; costFen: number }[] = [];
  const codeLines = new Map<string, number>(); // 码 → 行号（查系统里重复时定位）
  for (const row of rows) {
    const before = p.count;
    const store = findStore(p, row);
    const sku = findSku(p, row, "DEVICE");
    const codes = { sn: row.values.sn || null, imei1: row.values.imei1 || null, imei2: row.values.imei2 || null };
    for (const [key, label] of [["imei1", "IMEI1"], ["imei2", "IMEI2"], ["sn", "SN"]] as const) {
      const c = codes[key];
      if (c === null) continue;
      if (looksLikeScientific(c)) p.add(row.line, label, `“${c}”被 Excel 改成了科学计数法，后几位已经丢了：把这一列设成文本、重新填`);
      else if (key === "sn" ? !isValidSn(c) : !isValidImei(c)) p.add(row.line, label, key === "sn" ? `“${c}”格式不对（6 到 30 位字母、数字、横线，不能是 15 位纯数字）` : `“${c}”要 15 位数字`);
      else if (!dup(row, c)) codeLines.set(c, row.line);
    }
    if (!codes.sn && !codes.imei1 && !codes.imei2) p.add(row.line, "IMEI1", "SN、IMEI1、IMEI2 至少填一个");
    const costFen = checkMoney(p, row, "cost", "成本", true);
    if (p.count === before && store && sku) plan.push({ line: row.line, storeId: store.id, storeName: store.name, skuId: sku.id, codes, costFen: costFen! });
  }
  // 系统里已经有的码
  const all = [...codeLines.keys()];
  for (let i = 0; i < all.length; i += 1000) {
    const chunk = all.slice(i, i + 1000);
    const hits = await db.device.findMany({
      where: { OR: [{ code: { in: chunk } }, { sn: { in: chunk } }, { imei1: { in: chunk } }, { imei2: { in: chunk } }] },
      select: { code: true, sn: true, imei1: true, imei2: true, store: { select: { name: true } } },
    });
    for (const h of hits) {
      // 主码就是三个码之一，去重以后一个码只报一次
      for (const c of new Set([h.code, h.sn, h.imei1, h.imei2])) {
        if (c && codeLines.has(c)) p.add(codeLines.get(c)!, "码", `${c} 系统里已经有了（${h.store.name}）`);
      }
    }
  }
  const total = plan.reduce((s, d) => s + d.costFen, 0);
  return {
    problems: p.list,
    summary: [`期初入库 ${plan.length} 台，成本合计 ${(total / 100).toFixed(2)} 元`, `按门店：${countBy(plan, (d) => d.storeName)}`],
    createCount: plan.length,
    skipCount: 0,
    apply: async (tx, ctx) => {
      try {
        const created = await openingReceiveDevices(tx, { docNo: ctx.batchNo, operatorId: ctx.operatorId, devices: plan });
        return { created };
      } catch (error) {
        if (error instanceof StockError) throw new ImportError(error.message);
        throw error;
      }
    },
  };
}

// ---------- 配件期初 ----------

async function analyzeAccessories(rows: TableRow<(typeof ACCESSORY_COLUMNS)[number]["key"]>[], db: Db): Promise<Analysis> {
  const p = new Collector();
  const dup = dupChecker(p, "商品");
  const [findStore, findSku] = await Promise.all([storeResolver(db), skuResolver(db)]);
  const plan: { storeId: number; storeName: string; skuId: number; qty: number }[] = [];
  for (const row of rows) {
    const before = p.count;
    const store = findStore(p, row);
    const sku = findSku(p, row, "ACCESSORY");
    const qty = positiveInt(row.values.qty);
    if (qty === null) p.add(row.line, "数量", "没填");
    else if (Number.isNaN(qty)) p.add(row.line, "数量", `“${row.values.qty}”要填正整数`);
    if (store && sku) dup(row, `${store.id}|${sku.id}`, `${store.name} ${sku.name}`);
    if (p.count === before && store && sku && qty) plan.push({ storeId: store.id, storeName: store.name, skuId: sku.id, qty });
  }
  const total = plan.reduce((s, a) => s + a.qty, 0);
  return {
    problems: p.list,
    summary: [`期初入库配件 ${plan.length} 行，共 ${total} 件`, `按门店：${countBy(plan, (a) => a.storeName)}（行数）`],
    createCount: plan.length,
    skipCount: 0,
    apply: async (tx, ctx) => {
      for (const a of plan) await changeAccessoryStock(tx, { storeId: a.storeId, skuId: a.skuId, qtyDelta: a.qty, docType: "OPENING", docNo: ctx.batchNo, operatorId: ctx.operatorId });
      return { created: plan.length };
    },
  };
}

// ---------- 客户 ----------

/** 手机号：去掉空格、横杠，去掉 +86 / 86 前缀 */
export function normalizePhone(text: string): string {
  const t = text.replace(/[\s-]/g, "");
  return /^(\+?86)1\d{10}$/.test(t) ? t.replace(/^\+?86/, "") : t;
}

async function analyzeCustomers(rows: TableRow<(typeof CUSTOMER_COLUMNS)[number]["key"]>[], db: Db): Promise<Analysis> {
  const p = new Collector();
  const dup = dupChecker(p, "手机号");
  const plan: { name: string; phone: string; note: string | null; fp: string }[] = [];
  for (const row of rows) {
    const before = p.count;
    const name = checkLength(p, row, "name", "姓名", 30, true);
    const raw = row.values.phone;
    const phone = normalizePhone(raw);
    if (!raw) p.add(row.line, "手机号", "没填");
    else if (looksLikeScientific(raw)) p.add(row.line, "手机号", "被 Excel 改成了科学计数法，后几位已经丢了：把这一列设成文本、重新填");
    else if (!/^1\d{10}$/.test(phone)) p.add(row.line, "手机号", `“${raw}”不是 11 位手机号`);
    else dup(row, phone);
    const note = checkLength(p, row, "note", "备注", 200, false);
    if (p.count === before) plan.push({ name: name!, phone, note, fp: phoneFingerprint(phone) });
  }
  const existing = new Set<string>();
  for (let i = 0; i < plan.length; i += 1000) {
    const hits = await db.customer.findMany({ where: { phoneFp: { in: plan.slice(i, i + 1000).map((c) => c.fp) } }, select: { phoneFp: true } });
    for (const h of hits) existing.add(h.phoneFp);
  }
  const toCreate = plan.filter((c) => !existing.has(c.fp));
  return {
    problems: p.list,
    summary: [`新建客户 ${toCreate.length} 个`, ...(existing.size ? [`手机号系统里已经有的 ${existing.size} 个，跳过`] : []), "手机号加密保存"],
    createCount: toCreate.length,
    skipCount: existing.size,
    apply: async (tx, ctx) => {
      try {
        const r = await tx.customer.createMany({ data: toCreate.map((c) => ({ name: c.name, note: c.note, importBatchId: ctx.batchId, ...phoneColumns(c.phone) })) });
        return { created: r.count };
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") throw new ImportError("有手机号刚被别人建成客户了，重新上传预检一次");
        throw error;
      }
    },
  };
}

// ---------- 入口 ----------

function analyze(kind: ImportKindKey, cells: { line: number; cells: string[] }[], db: Db): Promise<Analysis> {
  switch (kind) {
    case "STORES":
      return analyzeStores(toRecords(cells, STORE_COLUMNS), db);
    case "USERS":
      return analyzeUsers(toRecords(cells, USER_COLUMNS), db);
    case "PRODUCTS":
      return analyzeProducts(toRecords(cells, PRODUCT_COLUMNS), db);
    case "DEVICES":
      return analyzeDevices(toRecords(cells, DEVICE_COLUMNS), db);
    case "ACCESSORIES":
      return analyzeAccessories(toRecords(cells, ACCESSORY_COLUMNS), db);
    case "CUSTOMERS":
      return analyzeCustomers(toRecords(cells, CUSTOMER_COLUMNS), db);
  }
}

function toCheck(kind: ImportKindKey, rowCount: number, a: Analysis): ImportCheck {
  const problems = [...a.problems].sort((x, y) => x.line - y.line);
  return { kind, rowCount, problems: problems.slice(0, MAX_PROBLEMS), problemCount: problems.length, summary: a.summary, createCount: a.createCount, skipCount: a.skipCount };
}

async function readRows(file: { bytes: Uint8Array; name: string }) {
  try {
    return await readUpload(file.bytes, file.name);
  } catch (error) {
    if (error instanceof TableError) throw new ImportError(error.message);
    throw error;
  }
}

function countDataRows(kind: ImportKindKey, cells: { line: number; cells: string[] }[]): number {
  try {
    return toRecords(cells, IMPORT_COLUMNS[kind]).length;
  } catch (error) {
    if (error instanceof TableError) throw new ImportError(error.message);
    throw error;
  }
}

/** 预检：只读，不写库 */
export async function precheckImport(user: CurrentUser, kind: ImportKindKey, file: { bytes: Uint8Array; name: string }, db: Db = prisma): Promise<ImportCheck> {
  assertHq(user);
  const cells = await readRows(file);
  const rowCount = countDataRows(kind, cells);
  return toCheck(kind, rowCount, await analyze(kind, cells, db));
}

/**
 * 确认导入：在一个事务里重新预检，没问题才写库、建导入记录、记操作日志；有问题返回预检结果（整批不进）。
 * 员工的初始密码在事务外先算好哈希（每个要几十毫秒）。
 */
export async function commitImport(
  user: CurrentUser,
  kind: ImportKindKey,
  file: { bytes: Uint8Array; name: string },
  options: { legalConfirmed?: boolean } = {},
  db?: Db,
): Promise<{ ok: true; done: ImportDone } | { ok: false; check: ImportCheck }> {
  assertHq(user);
  if (kind === "CUSTOMERS" && !options.legalConfirmed) throw new ImportError("先勾选确认这些手机号是门店合法收集的");
  const cells = await readRows(file);
  const rowCount = countDataRows(kind, cells);
  const passwords: string[] = [];
  const passwordHashes: string[] = [];
  if (kind === "USERS" && rowCount <= MAX_USER_ROWS) {
    for (let i = 0; i < rowCount; i++) {
      const pw = randomPassword();
      passwords.push(pw);
      passwordHashes.push(await hashPassword(pw));
    }
  }
  const run = async (tx: Db) => {
    if (kind === "STORES") await lockStoreQuota(tx); // 门店数上限：和组织管理建门店排队（复查第 68 条）
    const a = await analyze(kind, cells, tx);
    if (a.problems.length > 0) return { ok: false as const, check: toCheck(kind, rowCount, a) };
    if (a.createCount === 0) throw new ImportError("没有要新建的：表里的都已经在系统里了");
    const batchNo = await nextDocNo(tx, OPENING_KINDS.includes(kind) ? "QC" : "DR");
    const batch = await tx.importBatch.create({ data: { batchNo, kind, fileName: file.name.slice(0, 200), rowCount, createdCount: 0, summary: a.summary, createdById: user.id } });
    let result: Awaited<ReturnType<Analysis["apply"]>>;
    try {
      result = await a.apply(tx, { batchId: batch.id, batchNo, operatorId: user.id, passwordHashes, passwords });
    } catch (error) {
      // 预检之后、写库之前别人刚建了同一个门店编码、账号、条码、码
      if ((error as { code?: string }).code === "P2002") throw new ImportError("有数据刚被别人建了（编码、账号、条码或机器的码重复），重新上传预检一次");
      throw error;
    }
    await tx.importBatch.update({ where: { id: batch.id }, data: { createdCount: result.created } });
    await writeAudit(
      { userId: user.id, action: `import.${kind.toLowerCase()}`, entity: "import_batch", entityId: batch.id, detail: { batchNo, fileName: file.name, rows: rowCount, created: result.created, skipped: a.skipCount } },
      tx,
    );
    return { ok: true as const, done: { batchId: batch.id, batchNo, created: result.created, skipped: a.skipCount, summary: a.summary, ...result.extra } };
  };
  if (db) return run(db);
  return prisma.$transaction(run, { timeout: 300_000, maxWait: 10_000 });
}

/** 12 位初始密码：去掉容易看错的 0 O 1 l I（和开户脚本一样） */
function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[randomInt(chars.length)]).join("");
}

// ---------- 历次导入、撤销 ----------

export async function listImports(user: CurrentUser) {
  assertHq(user);
  const [batches, salesCount] = await Promise.all([
    prisma.importBatch.findMany({ orderBy: { id: "desc" }, take: 100, include: { createdBy: { select: { name: true } }, revokedBy: { select: { name: true } } } }),
    prisma.salesOrder.count(),
  ]);
  return batches.map((b) => ({
    id: b.id,
    batchNo: b.batchNo,
    kind: b.kind as ImportKindKey,
    status: b.status,
    fileName: b.fileName,
    rowCount: b.rowCount,
    createdCount: b.createdCount,
    summary: Array.isArray(b.summary) ? (b.summary as string[]) : [],
    createdBy: b.createdBy.name,
    createdAt: b.createdAt,
    revokedBy: b.revokedBy?.name ?? null,
    revokedAt: b.revokedAt,
    canRevoke: b.status === "DONE" && REVOCABLE_KINDS.includes(b.kind as ImportKindKey) && salesCount === 0,
  }));
}

/** 期初入库单明细：机器一台一行，配件一个商品一行 */
export async function getOpeningBatch(user: CurrentUser, id: number) {
  assertHq(user);
  const batch = await prisma.importBatch.findUnique({ where: { id }, include: { createdBy: { select: { name: true } }, revokedBy: { select: { name: true } } } });
  if (!batch || !OPENING_KINDS.includes(batch.kind as ImportKindKey)) return null;
  const lines = await prisma.stockLedger.findMany({
    where: { docNo: batch.batchNo, docType: "OPENING" },
    orderBy: { id: "asc" },
    take: 5000,
    select: { id: true, qtyDelta: true, store: { select: { code: true, name: true } }, sku: { select: { name: true } }, device: { select: { code: true, sn: true, imei1: true, imei2: true, costFen: true } } },
  });
  return { batch: { ...batch, kind: batch.kind as ImportKindKey, summary: Array.isArray(batch.summary) ? (batch.summary as string[]) : [] }, lines };
}

/**
 * 整批撤销（口径第 22 节）：只有期初入库单和客户导入；系统里还没开过销售单（作废的也算）才能撤。
 * 先把这条导入记录从“已导入”改成“已撤销”（两个人同时点只有一个成功），再删库存或客户。
 */
export async function revokeImport(user: CurrentUser, id: number, db?: Db): Promise<void> {
  assertHq(user);
  const run = async (tx: Db) => {
    const batch = await tx.importBatch.findUnique({ where: { id } });
    if (!batch) throw new ImportError("没有这次导入");
    if (!REVOCABLE_KINDS.includes(batch.kind as ImportKindKey)) throw new ImportError(`${IMPORT_KIND_LABELS[batch.kind as ImportKindKey]}导入不整批撤销：导错了在组织管理、商品页改或停用`);
    if ((await tx.salesOrder.count()) > 0) throw new ImportError("系统里已经开过销售单，不能整批撤销了：机器、配件数量不对走盘点纠正");
    const claimed = await tx.importBatch.updateMany({ where: { id, status: "DONE" }, data: { status: "REVOKED", revokedById: user.id, revokedAt: new Date() } });
    if (claimed.count !== 1) throw new ImportError("这次导入已经撤销过了");
    let detail: Record<string, number>;
    if (batch.kind === "CUSTOMERS") {
      try {
        detail = { customers: (await tx.customer.deleteMany({ where: { importBatchId: id } })).count };
      } catch (error) {
        if ((error as { code?: string }).code === "P2003") throw new ImportError("这批客户有的已经被单据用过（回收、维修、运营商业务……），不能整批撤销");
        throw error;
      }
    } else {
      try {
        detail = await revokeOpeningStock(tx, batch.batchNo);
      } catch (error) {
        if (error instanceof StockError) throw new ImportError(error.message);
        throw error;
      }
    }
    await writeAudit({ userId: user.id, action: "import.revoke", entity: "import_batch", entityId: id, detail: { batchNo: batch.batchNo, kind: batch.kind, ...detail } }, tx);
  };
  if (db) return run(db);
  await prisma.$transaction(run, { timeout: 120_000 });
}
