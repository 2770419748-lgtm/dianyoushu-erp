import type { Role } from "@/generated/prisma/enums";

// 角色与数据范围的判断函数。纯函数，不查库，方便单元测试。
// 口径（临时，等《业务口径》定稿后对齐）：
//   店员、店长只看本店；区域经理看辖区所有门店；总部看全部。

export const ROLE_LABELS: Record<Role, string> = {
  STAFF: "店员",
  STORE_MANAGER: "店长",
  REGIONAL_MANAGER: "区域经理",
  HQ: "总部",
};

export interface Actor {
  role: Role;
  storeId: number | null;
  regionId: number | null;
}

export type DataScope =
  | { kind: "all" }
  | { kind: "region"; regionId: number }
  | { kind: "store"; storeId: number }
  | { kind: "none" };

/** 这个人能看哪一片数据 */
export function getDataScope(actor: Actor): DataScope {
  switch (actor.role) {
    case "HQ":
      return { kind: "all" };
    case "REGIONAL_MANAGER":
      return actor.regionId === null ? { kind: "none" } : { kind: "region", regionId: actor.regionId };
    case "STORE_MANAGER":
    case "STAFF":
      return actor.storeId === null ? { kind: "none" } : { kind: "store", storeId: actor.storeId };
  }
}

/** 这个人能不能看某家门店（门店要带上所属区域） */
export function canAccessStore(actor: Actor, store: { id: number; regionId: number }): boolean {
  const scope = getDataScope(actor);
  switch (scope.kind) {
    case "all":
      return true;
    case "region":
      return store.regionId === scope.regionId;
    case "store":
      return store.id === scope.storeId;
    case "none":
      return false;
  }
}

/** 谁能管理组织（区域、门店、员工） */
export function canManageOrg(role: Role): boolean {
  return role === "HQ";
}

/** 谁能维护商品主数据（品类、品牌、型号、SKU、指导价） */
export function canManageProducts(role: Role): boolean {
  return role === "HQ";
}

/** 谁能改门店售价：店长（本店）、总部（任意店）；门店范围另由 scope 校验 */
export function canManagePrices(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能做采购（开采购单、到货入库） */
export function canManagePurchase(role: Role): boolean {
  return role === "HQ";
}

/** 谁能申请、发出、收货调拨：店长（本店）、总部 */
export function canManageTransfer(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能发起盘点和录实盘：店员、店长、总部 */
export function canEnterStocktake(role: Role): boolean {
  return role === "STAFF" || role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能确认或作废盘点：店长、总部 */
export function canConfirmStocktake(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能开单、退货、开回收单、管客户：店员、店长、总部 */
export function canSell(role: Role): boolean {
  return role === "STAFF" || role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能把回收机转良品：店长、总部 */
export function canRefurbish(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能作废销售单、回收单：店长、总部 */
export function canVoidSales(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

export interface MenuEntry {
  key: string;
  label: string;
  href?: string; // 没有 href 的还没做成页面，先显示为灰字
}

const MENU_STAFF: MenuEntry[] = [
  { key: "sales-new", label: "开单", href: "/sales/new" },
  { key: "stock", label: "查库存", href: "/stock" },
  { key: "products", label: "商品查价", href: "/products" },
  { key: "customers", label: "客户", href: "/customers" },
  { key: "sales-list", label: "我的订单", href: "/sales" },
  { key: "trade-ins", label: "回收", href: "/trade-ins" },
  { key: "stocktakes", label: "盘点", href: "/stocktakes" },
];

// 菜单 key 与 docs/页面清单.md 的路由一一对应，后面逐页做成真链接。
const MENU_STORE_MANAGER: MenuEntry[] = [
  ...MENU_STAFF.filter((m) => m.key !== "sales-list" && m.key !== "stocktakes" && m.key !== "trade-ins"),
  { key: "sales-list", label: "门店订单", href: "/sales" },
  { key: "transfers", label: "调拨", href: "/transfers" },
  { key: "stocktakes", label: "盘点", href: "/stocktakes" },
  { key: "trade-ins", label: "回收", href: "/trade-ins" },
  { key: "daily-close", label: "日结" },
  { key: "prices", label: "门店售价", href: "/products/prices" },
  { key: "reports", label: "门店报表" },
];

const MENU_REGIONAL: MenuEntry[] = [
  { key: "dashboard", label: "看板" },
  { key: "stores", label: "辖区门店", href: "/stores" },
  { key: "stock", label: "库存", href: "/stock" },
  { key: "reports", label: "报表" },
];

const MENU_HQ: MenuEntry[] = [
  { key: "dashboard", label: "看板" },
  { key: "org", label: "组织管理", href: "/org" },
  { key: "products", label: "商品", href: "/products" },
  { key: "prices", label: "门店售价", href: "/products/prices" },
  { key: "purchase", label: "采购入库", href: "/purchase" },
  { key: "stock", label: "库存", href: "/stock" },
  { key: "transfers", label: "调拨", href: "/transfers" },
  { key: "stocktakes", label: "盘点", href: "/stocktakes" },
  { key: "sales-new", label: "开单", href: "/sales/new" },
  { key: "sales-list", label: "销售", href: "/sales" },
  { key: "customers", label: "客户", href: "/customers" },
  { key: "trade-ins", label: "回收", href: "/trade-ins" },
  { key: "daily-close", label: "日结" },
  { key: "reports", label: "报表" },
  { key: "kpi", label: "KPI 目标" },
  { key: "logs", label: "操作日志", href: "/logs" },
  { key: "roadmap", label: "后续规划" },
];

/** 登录后左侧菜单（第 1 周先是假菜单，后面逐步换成真页面） */
export function getMenuForRole(role: Role): MenuEntry[] {
  switch (role) {
    case "STAFF":
      return MENU_STAFF;
    case "STORE_MANAGER":
      return MENU_STORE_MANAGER;
    case "REGIONAL_MANAGER":
      return MENU_REGIONAL;
    case "HQ":
      return MENU_HQ;
  }
}
