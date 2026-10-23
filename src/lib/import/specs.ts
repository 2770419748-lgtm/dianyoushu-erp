import type { ColumnSpec } from "./table";

// 各类导入的模板列（口径第 22 节）：列名、必填、别名（旧系统导出常见的叫法）、示例、说明。
// 模板下载、表头识别、导入页的说明都按这里来。纯数据，前后端共用。

export type ImportKindKey = "STORES" | "USERS" | "PRODUCTS" | "DEVICES" | "ACCESSORIES" | "CUSTOMERS";

export const IMPORT_KIND_LABELS: Record<ImportKindKey, string> = {
  STORES: "门店",
  USERS: "员工",
  PRODUCTS: "商品",
  DEVICES: "在库机器",
  ACCESSORIES: "配件期初",
  CUSTOMERS: "客户",
};

/** 导入页上的顺序（后面的要用前面的） */
export const IMPORT_KIND_ORDER: ImportKindKey[] = ["STORES", "USERS", "PRODUCTS", "DEVICES", "ACCESSORIES", "CUSTOMERS"];

/** 生成期初入库单（写库存流水）的两类 */
export const OPENING_KINDS: ImportKindKey[] = ["DEVICES", "ACCESSORIES"];

/** 能整批撤销的（还没开过销售单之前） */
export const REVOCABLE_KINDS: ImportKindKey[] = ["DEVICES", "ACCESSORIES", "CUSTOMERS"];

export const STORE_COLUMNS = [
  { key: "region", label: "区域", required: true, example: "华东区", note: "没有的区域会新建" },
  { key: "code", label: "门店编码", required: true, aliases: ["编码", "门店编号"], example: "S001", note: "字母数字，不能和别的门店重复" },
  { key: "name", label: "门店名称", required: true, aliases: ["门店", "名称"], example: "人民路店" },
  { key: "address", label: "地址", example: "人民路 88 号" },
] as const satisfies readonly ColumnSpec[];

export const USER_COLUMNS = [
  { key: "username", label: "账号", required: true, aliases: ["登录账号", "用户名"], example: "zhangsan", note: "小写字母、数字、下划线，3～30 位" },
  { key: "name", label: "姓名", required: true, example: "张三" },
  { key: "role", label: "角色", required: true, example: "店员", note: "总部、区域经理、店长、店员" },
  { key: "storeCode", label: "门店编码", example: "S001", note: "店长、店员填" },
  { key: "region", label: "区域", example: "", note: "区域经理填" },
  { key: "wecomUserid", label: "企业微信账号", example: "", note: "可不填" },
] as const satisfies readonly ColumnSpec[];

export const PRODUCT_COLUMNS = [
  { key: "category", label: "品类", required: true, aliases: ["分类", "类别"], example: "手机", note: "系统里已有的品类：手机、平板、配件……" },
  { key: "brand", label: "品牌", required: true, example: "华为" },
  { key: "model", label: "型号", required: true, aliases: ["商品名", "商品名称"], example: "Mate 70", note: "配件填商品名" },
  { key: "color", label: "颜色", example: "曜金黑" },
  { key: "storage", label: "容量", aliases: ["内存", "规格"], example: "12GB+256GB" },
  { key: "barcode", label: "条码", example: "", note: "可不填；填了不能和别的商品重复" },
  { key: "guide", label: "指导价", required: true, aliases: ["零售价", "售价"], example: "5499", note: "元" },
  { key: "cost", label: "参考成本", aliases: ["成本价", "进价"], example: "4900", note: "元，可不填" },
  { key: "safety", label: "安全库存", example: "", note: "配件可填，门店数量低于它标红" },
] as const satisfies readonly ColumnSpec[];

export const DEVICE_COLUMNS = [
  { key: "storeCode", label: "门店编码", required: true, example: "S001" },
  { key: "barcode", label: "条码", example: "", note: "填了条码，品牌型号颜色容量可以不填" },
  { key: "brand", label: "品牌", example: "华为" },
  { key: "model", label: "型号", aliases: ["商品名", "商品名称"], example: "Mate 70" },
  { key: "color", label: "颜色", example: "曜金黑" },
  { key: "storage", label: "容量", aliases: ["内存", "规格"], example: "12GB+256GB" },
  { key: "sn", label: "SN", aliases: ["序列号", "SN码"], example: "", note: "三个码至少填一个" },
  { key: "imei1", label: "IMEI1", aliases: ["IMEI", "串号", "IMEI码"], example: "860000000000001", note: "15 位数字；表格里这一列设成文本，不然会变成科学计数法丢位" },
  { key: "imei2", label: "IMEI2", aliases: ["串号2"], example: "" },
  { key: "cost", label: "成本", required: true, aliases: ["成本价", "进价"], example: "4900", note: "元" },
] as const satisfies readonly ColumnSpec[];

export const ACCESSORY_COLUMNS = [
  { key: "storeCode", label: "门店编码", required: true, example: "S001" },
  { key: "barcode", label: "条码", example: "", note: "填了条码，品牌商品名颜色可以不填" },
  { key: "brand", label: "品牌", example: "通用" },
  { key: "model", label: "商品名", aliases: ["型号", "商品名称"], example: "钢化膜（高清）" },
  { key: "color", label: "颜色", example: "" },
  { key: "qty", label: "数量", required: true, aliases: ["库存", "库存数量"], example: "20" },
] as const satisfies readonly ColumnSpec[];

export const CUSTOMER_COLUMNS = [
  { key: "name", label: "姓名", required: true, aliases: ["客户姓名", "客户"], example: "王先生" },
  { key: "phone", label: "手机号", required: true, aliases: ["手机", "电话", "联系电话"], example: "13800000000" },
  { key: "note", label: "备注", example: "" },
] as const satisfies readonly ColumnSpec[];

export const IMPORT_COLUMNS: Record<ImportKindKey, readonly ColumnSpec[]> = {
  STORES: STORE_COLUMNS,
  USERS: USER_COLUMNS,
  PRODUCTS: PRODUCT_COLUMNS,
  DEVICES: DEVICE_COLUMNS,
  ACCESSORIES: ACCESSORY_COLUMNS,
  CUSTOMERS: CUSTOMER_COLUMNS,
};

/** 商品名：型号 + 容量 + 颜色（和种子、商品页的写法一样，如“Mate 70 12GB+256GB 曜金黑”） */
export function skuDisplayName(model: string, storage: string | null, color: string | null): string {
  return [model, storage, color].filter((s) => s && s.trim()).join(" ");
}

/** 同一个商品的认法：型号 + 颜色 + 容量（不分大小写、空格），空的当空串 */
export function skuKey(modelId: number, color: string | null, storage: string | null): string {
  const norm = (s: string | null) => (s ?? "").replace(/\s+/g, "").toLowerCase();
  return `${modelId}|${norm(color)}|${norm(storage)}`;
}

/** 按名字认商品：品牌、型号、颜色、容量都去掉空白、不分大小写，拼成一个键（机型库添加、导入时判断“系统里已经有了”） */
export function nameKey(...parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? "").replace(/\s+/g, "").toLowerCase()).join("|");
}

export function isImportKind(value: unknown): value is ImportKindKey {
  return typeof value === "string" && (IMPORT_KIND_ORDER as string[]).includes(value);
}
