import type { PrismaClient } from "../../src/generated/prisma/client";

// 商品模拟数据：50 个主流在售机型（手机、平板）+ 30 个配件 SKU，价格段按 2026 年市场大致行情。
// 价格是演示用的近似值，不是报价依据。可反复运行：品类按名称、品牌按名称、型号按（品牌，名称）、SKU 按条码 upsert。

interface DeviceModelSeed {
  brand: string;
  category: "手机" | "平板";
  name: string;
  colors: string[];
  variants: { storage: string; guideYuan: number }[];
}

interface AccessorySeed {
  brand: string;
  name: string;
  guideYuan: number;
  costYuan: number;
}

export const CATEGORY_SEED = [
  { name: "手机", kind: "DEVICE" as const, sortOrder: 1 },
  { name: "平板", kind: "DEVICE" as const, sortOrder: 2 },
  { name: "配件", kind: "ACCESSORY" as const, sortOrder: 3 },
  { name: "服务", kind: "ACCESSORY" as const, sortOrder: 4 }, // 碎屏险、延保：小件品类下的服务类商品，不管库存
];

/** 服务类商品（口径第 12 节）：开单生成服务权益，到期提醒。季度版碎屏险让演示数据里有快到期的 */
export const SERVICE_SEED = [
  { name: "碎屏险 1 年", months: 12, guideYuan: 199, costYuan: 80, kind: "SCREEN_INSURANCE" as const },
  { name: "碎屏险 季度版", months: 3, guideYuan: 69, costYuan: 25, kind: "SCREEN_INSURANCE" as const },
  { name: "延保 1 年", months: 12, guideYuan: 299, costYuan: 120, kind: "EXTENDED_WARRANTY" as const },
];

const v = (storage: string, guideYuan: number) => ({ storage, guideYuan });

export const DEVICE_MODEL_SEED: DeviceModelSeed[] = [
  // 华为
  { brand: "华为", category: "手机", name: "Mate 70", colors: ["曜金黑", "雪域白", "北国之春"], variants: [v("12GB+256GB", 5499), v("12GB+512GB", 5999)] },
  { brand: "华为", category: "手机", name: "Mate 70 Pro", colors: ["曜金黑", "雪域白", "云杉绿"], variants: [v("12GB+256GB", 6499), v("12GB+512GB", 6999)] },
  { brand: "华为", category: "手机", name: "Mate 70 Pro+", colors: ["宝石黑", "砚黑"], variants: [v("16GB+512GB", 8499), v("16GB+1TB", 8999)] },
  { brand: "华为", category: "手机", name: "Mate X6", colors: ["曜金黑", "星河蓝"], variants: [v("12GB+512GB", 12999), v("16GB+1TB", 13999)] },
  { brand: "华为", category: "手机", name: "Mate XT 非凡大师", colors: ["瑞红", "玄黑"], variants: [v("16GB+256GB", 17999), v("16GB+1TB", 19999)] },
  { brand: "华为", category: "手机", name: "Pura 70", colors: ["雪域白", "幻影黑", "樱玫红"], variants: [v("12GB+256GB", 4999), v("12GB+512GB", 5499)] },
  { brand: "华为", category: "手机", name: "Pura 70 Pro", colors: ["雪域白", "幻影黑"], variants: [v("12GB+256GB", 5999), v("12GB+512GB", 6499)] },
  { brand: "华为", category: "手机", name: "Pura 80", colors: ["幻夜黑", "冰晶蓝", "松月青"], variants: [v("12GB+256GB", 4699), v("12GB+512GB", 5199)] },
  { brand: "华为", category: "手机", name: "Pura 80 Pro", colors: ["幻夜黑", "冰晶蓝"], variants: [v("12GB+256GB", 6499), v("12GB+512GB", 6999)] },
  { brand: "华为", category: "手机", name: "nova 13", colors: ["镜光黑", "羽砂紫", "珠光白"], variants: [v("12GB+256GB", 2699), v("12GB+512GB", 2999)] },
  { brand: "华为", category: "手机", name: "nova 14", colors: ["樱语白", "幻夜黑", "映月蓝"], variants: [v("12GB+256GB", 2999), v("12GB+512GB", 3299)] },
  { brand: "华为", category: "平板", name: "MatePad Pro 13.2", colors: ["曜金黑", "晶钻白"], variants: [v("12GB+256GB", 5199), v("12GB+512GB", 5699)] },
  { brand: "华为", category: "平板", name: "MatePad 11.5", colors: ["深空灰", "晶钻白"], variants: [v("8GB+128GB", 1999), v("8GB+256GB", 2299)] },
  // 苹果
  { brand: "苹果", category: "手机", name: "iPhone 16", colors: ["黑色", "白色", "群青色"], variants: [v("128GB", 5999), v("256GB", 6999)] },
  { brand: "苹果", category: "手机", name: "iPhone 16 Plus", colors: ["黑色", "白色", "深青色"], variants: [v("128GB", 6999), v("256GB", 7999)] },
  { brand: "苹果", category: "手机", name: "iPhone 16 Pro", colors: ["沙漠色钛金属", "黑色钛金属", "白色钛金属"], variants: [v("128GB", 7999), v("256GB", 8999)] },
  { brand: "苹果", category: "手机", name: "iPhone 16 Pro Max", colors: ["沙漠色钛金属", "黑色钛金属"], variants: [v("256GB", 9999), v("512GB", 11999)] },
  { brand: "苹果", category: "手机", name: "iPhone 16e", colors: ["黑色", "白色"], variants: [v("128GB", 4499), v("256GB", 4999)] },
  { brand: "苹果", category: "手机", name: "iPhone 17", colors: ["黑色", "白色", "薰衣草紫"], variants: [v("256GB", 5999), v("512GB", 7499)] },
  { brand: "苹果", category: "手机", name: "iPhone 17 Pro", colors: ["深蓝色", "宇宙橙色", "银色"], variants: [v("256GB", 8999), v("512GB", 10499)] },
  { brand: "苹果", category: "手机", name: "iPhone 17 Pro Max", colors: ["深蓝色", "宇宙橙色", "银色"], variants: [v("256GB", 9999), v("512GB", 11499)] },
  { brand: "苹果", category: "手机", name: "iPhone Air", colors: ["天蓝色", "浅金色", "深空黑色"], variants: [v("256GB", 7999), v("512GB", 9499)] },
  { brand: "苹果", category: "平板", name: "iPad (A16)", colors: ["蓝色", "银色"], variants: [v("128GB", 2999), v("256GB", 3499)] },
  { brand: "苹果", category: "平板", name: "iPad Air 11", colors: ["深空灰", "紫色"], variants: [v("128GB", 4799), v("256GB", 5599)] },
  // 小米
  { brand: "小米", category: "手机", name: "小米 15", colors: ["黑色", "白色", "浅草绿"], variants: [v("12GB+256GB", 4499), v("16GB+512GB", 4999)] },
  { brand: "小米", category: "手机", name: "小米 15 Pro", colors: ["黑色", "白色", "云杉绿"], variants: [v("12GB+256GB", 5299), v("16GB+512GB", 5799)] },
  { brand: "小米", category: "手机", name: "小米 15 Ultra", colors: ["黑色", "白色", "松柏绿"], variants: [v("12GB+256GB", 6499), v("16GB+512GB", 6999)] },
  { brand: "小米", category: "手机", name: "小米 16", colors: ["黑色", "白色", "青色"], variants: [v("12GB+256GB", 4999), v("16GB+512GB", 5499)] },
  { brand: "小米", category: "手机", name: "小米 Civi 5 Pro", colors: ["牛油果绿", "烟波灰"], variants: [v("12GB+256GB", 2999), v("12GB+512GB", 3299)] },
  { brand: "小米", category: "手机", name: "REDMI K80", colors: ["雪岩白", "山峦青", "黑色"], variants: [v("12GB+256GB", 2499), v("16GB+512GB", 2999)] },
  { brand: "小米", category: "手机", name: "REDMI K80 Pro", colors: ["雪岩白", "山峦青"], variants: [v("12GB+256GB", 3699), v("16GB+512GB", 4199)] },
  { brand: "小米", category: "手机", name: "REDMI Note 14 Pro", colors: ["星沙青", "子夜黑"], variants: [v("8GB+256GB", 1499), v("12GB+512GB", 1899)] },
  { brand: "小米", category: "平板", name: "小米平板 7", colors: ["云杉绿", "黑色"], variants: [v("8GB+128GB", 1999), v("8GB+256GB", 2299)] },
  // 荣耀
  { brand: "荣耀", category: "手机", name: "Magic7", colors: ["绒黑色", "天空之境", "月影白"], variants: [v("12GB+256GB", 4499), v("16GB+512GB", 4999)] },
  { brand: "荣耀", category: "手机", name: "Magic7 Pro", colors: ["绒黑色", "月影白"], variants: [v("12GB+256GB", 5699), v("16GB+512GB", 6199)] },
  { brand: "荣耀", category: "手机", name: "Magic V3", colors: ["绒黑色", "沙漠金"], variants: [v("12GB+512GB", 8999), v("16GB+1TB", 9999)] },
  { brand: "荣耀", category: "手机", name: "荣耀 300", colors: ["茶白", "墨岩黑", "新绿"], variants: [v("12GB+256GB", 2999), v("12GB+512GB", 3299)] },
  { brand: "荣耀", category: "手机", name: "荣耀 400", colors: ["雪域白", "月影灰"], variants: [v("12GB+256GB", 2499), v("12GB+512GB", 2799)] },
  // OPPO
  { brand: "OPPO", category: "手机", name: "Find X8", colors: ["星野黑", "月光白", "海天蓝"], variants: [v("12GB+256GB", 4199), v("16GB+512GB", 4699)] },
  { brand: "OPPO", category: "手机", name: "Find X8 Pro", colors: ["星野黑", "月光白"], variants: [v("12GB+256GB", 5299), v("16GB+512GB", 5799)] },
  { brand: "OPPO", category: "手机", name: "Reno13", colors: ["蝶羽紫", "星夜黑", "蝶羽白"], variants: [v("12GB+256GB", 2699), v("12GB+512GB", 2999)] },
  { brand: "OPPO", category: "手机", name: "Reno14 Pro", colors: ["海神蓝", "晨曦金"], variants: [v("12GB+256GB", 3499), v("16GB+512GB", 3999)] },
  // vivo
  { brand: "vivo", category: "手机", name: "X200", colors: ["钛色", "宝石蓝", "简黑"], variants: [v("12GB+256GB", 4299), v("16GB+512GB", 4799)] },
  { brand: "vivo", category: "手机", name: "X200 Pro", colors: ["钛色", "宝石蓝"], variants: [v("12GB+256GB", 5299), v("16GB+512GB", 5799)] },
  { brand: "vivo", category: "手机", name: "S30", colors: ["云雾白", "极光紫"], variants: [v("12GB+256GB", 2699), v("12GB+512GB", 2999)] },
  { brand: "vivo", category: "手机", name: "iQOO 13", colors: ["传奇版", "曜夜", "赛道版"], variants: [v("12GB+256GB", 3999), v("16GB+512GB", 4499)] },
  // 一加、三星
  { brand: "一加", category: "手机", name: "一加 13", colors: ["蓝调时刻", "微尘黑"], variants: [v("12GB+256GB", 4499), v("16GB+512GB", 4999)] },
  { brand: "一加", category: "手机", name: "一加 Ace 5", colors: ["月岩黑", "银河蓝"], variants: [v("12GB+256GB", 2299), v("16GB+512GB", 2799)] },
  { brand: "三星", category: "手机", name: "Galaxy S25", colors: ["冰川蓝", "暗夜黑"], variants: [v("12GB+256GB", 5999), v("12GB+512GB", 6999)] },
  { brand: "三星", category: "手机", name: "Galaxy Z Flip7", colors: ["冰川蓝", "暗夜黑"], variants: [v("12GB+256GB", 7999), v("12GB+512GB", 8499)] },
];

export const ACCESSORY_SEED: AccessorySeed[] = [
  { brand: "华为", name: "华为 66W 超级快充充电器", guideYuan: 199, costYuan: 120 },
  { brand: "华为", name: "华为 100W 超级快充充电器", guideYuan: 299, costYuan: 180 },
  { brand: "华为", name: "华为 FreeBuds 6", guideYuan: 999, costYuan: 720 },
  { brand: "华为", name: "华为 FreeBuds SE 3", guideYuan: 199, costYuan: 130 },
  { brand: "华为", name: "华为 M-Pencil 第三代", guideYuan: 599, costYuan: 420 },
  { brand: "华为", name: "华为 Mate 70 原装保护壳", guideYuan: 199, costYuan: 90 },
  { brand: "华为", name: "华为 Type-C 数据线 1m", guideYuan: 59, costYuan: 25 },
  { brand: "苹果", name: "Apple 20W USB-C 电源适配器", guideYuan: 149, costYuan: 95 },
  { brand: "苹果", name: "Apple 35W 双 USB-C 电源适配器", guideYuan: 399, costYuan: 260 },
  { brand: "苹果", name: "Apple USB-C 充电线 1m", guideYuan: 145, costYuan: 80 },
  { brand: "苹果", name: "AirPods 4", guideYuan: 999, costYuan: 760 },
  { brand: "苹果", name: "AirPods Pro 3", guideYuan: 1899, costYuan: 1450 },
  { brand: "苹果", name: "iPhone 17 Pro MagSafe 硅胶保护壳", guideYuan: 399, costYuan: 220 },
  { brand: "小米", name: "小米 90W 氮化镓充电器", guideYuan: 199, costYuan: 110 },
  { brand: "小米", name: "小米 Buds 5", guideYuan: 399, costYuan: 260 },
  { brand: "小米", name: "小米 20000mAh 充电宝 33W", guideYuan: 129, costYuan: 75 },
  { brand: "小米", name: "小米 15 透明保护壳", guideYuan: 69, costYuan: 25 },
  { brand: "荣耀", name: "荣耀 Earbuds X7", guideYuan: 199, costYuan: 120 },
  { brand: "荣耀", name: "荣耀 100W 超级快充套装", guideYuan: 249, costYuan: 150 },
  { brand: "通用", name: "钢化膜（高清）", guideYuan: 29, costYuan: 6 },
  { brand: "通用", name: "钢化膜（防窥）", guideYuan: 49, costYuan: 12 },
  { brand: "通用", name: "钢化膜（抗蓝光）", guideYuan: 39, costYuan: 9 },
  { brand: "通用", name: "平板钢化膜", guideYuan: 59, costYuan: 15 },
  { brand: "通用", name: "透明防摔手机壳", guideYuan: 49, costYuan: 12 },
  { brand: "通用", name: "液态硅胶手机壳", guideYuan: 69, costYuan: 18 },
  { brand: "通用", name: "平板三折保护套", guideYuan: 99, costYuan: 35 },
  { brand: "通用", name: "Type-C 快充数据线 1m", guideYuan: 29, costYuan: 8 },
  { brand: "通用", name: "车载磁吸支架", guideYuan: 59, costYuan: 20 },
  { brand: "通用", name: "桌面手机支架", guideYuan: 39, costYuan: 12 },
  { brand: "通用", name: "手机挂绳", guideYuan: 19, costYuan: 4 },
];

// 用商品名算一个稳定的 13 位条码（69 开头像国产商品条码），同名商品每次生成的条码一样
export function stableBarcode(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  const digits = (String(h1).padStart(10, "0") + String(h2).padStart(10, "0")).slice(0, 11);
  return `69${digits}`;
}

/** 品类（手机、平板、配件、服务），返回名字 → id */
async function seedCategories(prisma: PrismaClient): Promise<Map<string, number>> {
  const categoryIds = new Map<string, number>();
  for (const c of CATEGORY_SEED) {
    const row = await prisma.category.upsert({
      where: { name: c.name },
      update: { kind: c.kind, sortOrder: c.sortOrder, isActive: true },
      create: c,
    });
    categoryIds.set(c.name, row.id);
  }
  return categoryIds;
}

/** 默认服务商品（碎屏险、延保）和回收用的“其他机型”，返回建了几个 SKU */
async function seedBaseItems(prisma: PrismaClient, categoryIds: Map<string, number>): Promise<number> {
  let skuCount = 0;
  // 服务类商品：一个服务一个型号一个 SKU，品牌记“门店服务”
  const serviceBrand = await prisma.brand.upsert({ where: { name: "门店服务" }, update: { isActive: true }, create: { name: "门店服务" } });
  const serviceCategoryId = categoryIds.get("服务")!;
  for (const sv of SERVICE_SEED) {
    const model = await prisma.productModel.upsert({
      where: { brandId_name: { brandId: serviceBrand.id, name: sv.name } },
      update: { categoryId: serviceCategoryId, isActive: true },
      create: { brandId: serviceBrand.id, categoryId: serviceCategoryId, name: sv.name },
    });
    const barcode = stableBarcode(`门店服务|${sv.name}`);
    const data = { modelId: model.id, name: sv.name, guidePriceFen: sv.guideYuan * 100, costPriceFen: sv.costYuan * 100, safetyQty: 0, isService: true, serviceMonths: sv.months, serviceKind: sv.kind };
    await prisma.sku.upsert({ where: { barcode }, update: { ...data, isActive: true }, create: { ...data, barcode } });
    skuCount++;
  }

  // 回收用的"其他机型"：旧机对不上现有型号时选它，真实机型写在回收单上
  const otherBrand = await prisma.brand.upsert({ where: { name: "其他" }, update: { isActive: true }, create: { name: "其他" } });
  const otherModel = await prisma.productModel.upsert({
    where: { brandId_name: { brandId: otherBrand.id, name: "其他回收机" } },
    update: { categoryId: categoryIds.get("手机")!, isActive: true },
    create: { brandId: otherBrand.id, categoryId: categoryIds.get("手机")!, name: "其他回收机" },
  });
  const genericBarcode = stableBarcode("其他|回收机（其他机型）");
  await prisma.sku.upsert({
    where: { barcode: genericBarcode },
    update: { modelId: otherModel.id, name: "回收机（其他机型）", guidePriceFen: 0, costPriceFen: 0, isActive: true },
    create: { modelId: otherModel.id, name: "回收机（其他机型）", barcode: genericBarcode, guidePriceFen: 0, costPriceFen: 0 },
  });
  skuCount++;

  return skuCount;
}

/**
 * 开户（pnpm tenant:init，口径第 21 节）和演示都要的基础数据：品类、默认服务商品、回收用的“其他机型”。
 * 不含机型库和配件（开户后在商品页从机型库勾选）。可反复运行。
 */
export async function seedBaseline(prisma: PrismaClient): Promise<{ skus: number }> {
  const categoryIds = await seedCategories(prisma);
  return { skus: await seedBaseItems(prisma, categoryIds) };
}

export async function seedProducts(prisma: PrismaClient) {
  // 品类
  const categoryIds = await seedCategories(prisma);

  // 品牌
  const brandNames = new Set<string>([...DEVICE_MODEL_SEED.map((m) => m.brand), ...ACCESSORY_SEED.map((a) => a.brand)]);
  const brandIds = new Map<string, number>();
  for (const name of brandNames) {
    const row = await prisma.brand.upsert({ where: { name }, update: { isActive: true }, create: { name } });
    brandIds.set(name, row.id);
  }

  // 大件：型号 + SKU（容量 × 颜色）
  let skuCount = 0;
  for (const m of DEVICE_MODEL_SEED) {
    const brandId = brandIds.get(m.brand)!;
    const categoryId = categoryIds.get(m.category)!;
    const model = await prisma.productModel.upsert({
      where: { brandId_name: { brandId, name: m.name } },
      update: { categoryId, isActive: true },
      create: { brandId, categoryId, name: m.name },
    });
    for (const variant of m.variants) {
      for (const color of m.colors) {
        const name = `${m.name} ${variant.storage} ${color}`;
        const guidePriceFen = variant.guideYuan * 100;
        const costPriceFen = Math.round(variant.guideYuan * (m.category === "平板" ? 0.88 : 0.9)) * 100;
        const barcode = stableBarcode(`${m.brand}|${name}`);
        await prisma.sku.upsert({
          where: { barcode },
          update: { modelId: model.id, name, color, storage: variant.storage, guidePriceFen, costPriceFen, isActive: true },
          create: { modelId: model.id, name, color, storage: variant.storage, barcode, guidePriceFen, costPriceFen },
        });
        skuCount++;
      }
    }
  }

  // 小件：一个配件一个型号一个 SKU
  const accessoryCategoryId = categoryIds.get("配件")!;
  for (const a of ACCESSORY_SEED) {
    const brandId = brandIds.get(a.brand)!;
    const model = await prisma.productModel.upsert({
      where: { brandId_name: { brandId, name: a.name } },
      update: { categoryId: accessoryCategoryId, isActive: true },
      create: { brandId, categoryId: accessoryCategoryId, name: a.name },
    });
    const barcode = stableBarcode(`${a.brand}|${a.name}`);
    // 配件默认安全库存 10 件：门店数量低于它在库存页标红
    await prisma.sku.upsert({
      where: { barcode },
      update: { modelId: model.id, name: a.name, guidePriceFen: a.guideYuan * 100, costPriceFen: a.costYuan * 100, safetyQty: 10, isActive: true },
      create: { modelId: model.id, name: a.name, barcode, guidePriceFen: a.guideYuan * 100, costPriceFen: a.costYuan * 100, safetyQty: 10 },
    });
    skuCount++;
  }

  skuCount += await seedBaseItems(prisma, categoryIds);

  return { models: DEVICE_MODEL_SEED.length + ACCESSORY_SEED.length + SERVICE_SEED.length, deviceModels: DEVICE_MODEL_SEED.length, accessories: ACCESSORY_SEED.length, services: SERVICE_SEED.length, skus: skuCount };
}
