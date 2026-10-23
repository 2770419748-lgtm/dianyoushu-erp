// 内置机型库（口径第 22 节）：常见品牌在售的手机、平板，品牌、型号、颜色、容量和参考指导价。纯数据，前后端共用。
// - 开户后商品是空的，总部在“商品 → 从机型库添加”里勾型号、颜色、容量，改指导价，一次建好商品；
// - 价格是首发价或大致行情，只是建议，勾选时改；颜色名以厂商为准，勾选时可以增删；
// - 随系统升级补新机，不会改已经建好的商品；库里没有的在商品页手工建或者用 Excel 导。
// 演示数据（prisma/seed-data/products.ts）用的是这里的前 50 个。

export interface LibraryModel {
  brand: string;
  category: "手机" | "平板";
  name: string;
  colors: string[];
  variants: { storage: string; guideYuan: number }[];
}

const v = (storage: string, guideYuan: number) => ({ storage, guideYuan });

export const MODEL_LIBRARY: LibraryModel[] = [
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
  // ---- 以下是演示数据没用到的常见机型（2026-10-23 补）----
  // 苹果
  { brand: "苹果", category: "手机", name: "iPhone 15", colors: ["黑色", "蓝色", "绿色", "黄色", "粉色"], variants: [v("128GB", 5999), v("256GB", 6999), v("512GB", 8999)] },
  { brand: "苹果", category: "手机", name: "iPhone 15 Plus", colors: ["黑色", "蓝色", "绿色", "黄色", "粉色"], variants: [v("128GB", 6999), v("256GB", 7999), v("512GB", 9999)] },
  { brand: "苹果", category: "手机", name: "iPhone 15 Pro", colors: ["原色钛金属", "蓝色钛金属", "白色钛金属", "黑色钛金属"], variants: [v("128GB", 7999), v("256GB", 8999), v("512GB", 10999)] },
  { brand: "苹果", category: "手机", name: "iPhone 15 Pro Max", colors: ["原色钛金属", "蓝色钛金属", "白色钛金属", "黑色钛金属"], variants: [v("256GB", 9999), v("512GB", 11999), v("1TB", 13999)] },
  { brand: "苹果", category: "手机", name: "iPhone 14", colors: ["午夜色", "星光色", "紫色", "蓝色", "红色", "黄色"], variants: [v("128GB", 5999), v("256GB", 6899)] },
  // 华为
  { brand: "华为", category: "手机", name: "Mate 60", colors: ["雅川青", "白沙银", "南糯紫", "雅丹黑"], variants: [v("12GB+256GB", 5499), v("12GB+512GB", 5999)] },
  { brand: "华为", category: "手机", name: "Mate 60 Pro", colors: ["雅川青", "白沙银", "南糯紫", "雅丹黑"], variants: [v("12GB+256GB", 6499), v("12GB+512GB", 6999)] },
  { brand: "华为", category: "手机", name: "Mate 60 Pro+", colors: ["砚黑", "宣白"], variants: [v("16GB+512GB", 8999), v("16GB+1TB", 9999)] },
  { brand: "华为", category: "手机", name: "Pura 70 Ultra", colors: ["星芒黑", "星芒白", "香颂绿", "摩卡棕"], variants: [v("16GB+512GB", 9999), v("16GB+1TB", 10999)] },
  // 小米
  { brand: "小米", category: "手机", name: "小米 14", colors: ["黑色", "白色", "岩石青", "雪山粉"], variants: [v("12GB+256GB", 4299), v("16GB+512GB", 4599)] },
  { brand: "小米", category: "手机", name: "小米 14 Ultra", colors: ["黑色", "白色", "龙晶蓝"], variants: [v("12GB+256GB", 6499), v("16GB+512GB", 6999)] },
  { brand: "小米", category: "手机", name: "REDMI K70", colors: ["墨羽", "晴雪", "竹月蓝", "浅茄紫"], variants: [v("12GB+256GB", 2499), v("16GB+512GB", 2999)] },
  { brand: "小米", category: "手机", name: "REDMI K70 Pro", colors: ["墨羽", "晴雪", "竹月蓝"], variants: [v("12GB+256GB", 3299), v("16GB+512GB", 3799)] },
  // 荣耀
  { brand: "荣耀", category: "手机", name: "Magic6", colors: ["绒黑色", "祁连雪", "湖水青"], variants: [v("12GB+256GB", 4399), v("16GB+512GB", 4999)] },
  // OPPO
  { brand: "OPPO", category: "手机", name: "Find X7", colors: ["星空黑", "烟云紫", "海阔天空"], variants: [v("12GB+256GB", 3999), v("16GB+512GB", 4499)] },
  // vivo
  { brand: "vivo", category: "手机", name: "X100", colors: ["辰夜黑", "白月光", "落日橙", "星迹蓝"], variants: [v("12GB+256GB", 3999), v("16GB+512GB", 4499)] },
  { brand: "vivo", category: "手机", name: "X100 Pro", colors: ["辰夜黑", "白月光", "落日橙", "星迹蓝"], variants: [v("12GB+256GB", 4999), v("16GB+512GB", 5499)] },
  // 三星、一加
  { brand: "三星", category: "手机", name: "Galaxy S24", colors: ["雅岩灰", "秘矿紫", "浅珀黄", "水墨黑"], variants: [v("8GB+256GB", 5999), v("8GB+512GB", 6999)] },
  { brand: "一加", category: "手机", name: "一加 12", colors: ["岩黑", "留白", "苍绿"], variants: [v("12GB+256GB", 4299), v("16GB+512GB", 4799)] },
];

/** 机型在库里的标识：品牌 + 型号 */
export function libraryKey(m: { brand: string; name: string }): string {
  return `${m.brand}|${m.name}`;
}

export const LIBRARY_BRANDS: string[] = [...new Set(MODEL_LIBRARY.map((m) => m.brand))];
