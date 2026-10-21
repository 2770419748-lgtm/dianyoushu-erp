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

/** 谁能做日结（录实收、确认）：店长（本店）、总部 */
export function canCloseDay(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能把回收机转良品：店长、总部 */
export function canRefurbish(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能录 KPI 目标：只有总部（门店和区域只看完成率） */
export function canManageKpi(role: Role): boolean {
  return role === "HQ";
}

/**
 * 企业微信跟进关系谁能看（口径第 12 节）：跟进员工本人；他所在门店的店长；区域经理看辖区；总部全部。
 * 还没对上 ERP 员工的跟进关系（storeId、regionId 为空）只有总部看得到。
 */
export function canSeeWecomFollow(
  viewer: { id: number; role: Role; storeId: number | null; regionId: number | null },
  follow: { userId: number | null; storeId: number | null; regionId: number | null },
): boolean {
  switch (viewer.role) {
    case "HQ":
      return true;
    case "REGIONAL_MANAGER":
      return follow.regionId !== null && follow.regionId === viewer.regionId;
    case "STORE_MANAGER":
      return follow.storeId !== null && follow.storeId === viewer.storeId;
    case "STAFF":
      return follow.userId !== null && follow.userId === viewer.id;
  }
}

/** 员工档案谁能看（口径第 19 节）：店长本店、区域经理辖区、总部；店员只在“我的”里看自己的 */
export function canViewEmployees(role: Role): boolean {
  return role !== "STAFF";
}

/** 员工档案谁能改：总部 */
export function canEditEmployees(role: Role): boolean {
  return role === "HQ";
}

/** 谁能发公告：总部（全部、区域、门店）、店长（本店） */
export function canPublishNotice(role: Role): boolean {
  return role === "HQ" || role === "STORE_MANAGER";
}

/** 谁能看门店排班和别人的考勤（口径第 19 节）：店长本店、区域经理辖区（只看）、总部；店员只看自己的 */
export function canViewTeamAttendance(role: Role): boolean {
  return role !== "STAFF";
}

/** 谁能排班、给员工补卡：店长（本店）、总部；区域经理只看 */
export function canManageAttendance(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能转接企业微信客户、安排离职继承（口径第 12 节第三步）：店长（本店员工的客户）、总部 */
export function canTransferWecomCustomer(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能办售后：接件、报价、维修、取机结算（口径第 13 节）：店员、店长、总部；区域经理只看 */
export function canHandleRepair(role: Role): boolean {
  return role === "STAFF" || role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能登记、确认运营商业务（口径第 14 节）：店员、店长、总部；区域经理只看 */
export function canHandleCarrier(role: Role): boolean {
  return role === "STAFF" || role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能维护运营商佣金政策、导入结算单对账：总部 */
export function canManageCarrier(role: Role): boolean {
  return role === "HQ";
}

/** 谁能维护国补政策、导入平台审核结果、标记已退回（口径第 15 节）：总部；开单用国补、提交审核同开单权限 */
export function canManageSubsidy(role: Role): boolean {
  return role === "HQ";
}

/** 谁能开具、红冲发票，维护公司开票信息（口径第 16 节）：总部；申请开票同开单权限 */
export function canManageInvoice(role: Role): boolean {
  return role === "HQ";
}

/** 谁能确认纸质票到店：店长（本店）、总部 */
export function canMarkInvoiceDelivered(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能改审批规则（口径第 17 节）：总部；谁能批看规则（店长批本店要店长批的，总部都能批），见 src/lib/approval.ts canDecide */
export function canManageApprovalRules(role: Role): boolean {
  return role === "HQ";
}

/** 谁能作废运营商业务单：店长（本店）、总部 */
export function canVoidCarrier(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能作废维修单：店长、总部 */
export function canVoidRepair(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能跟进到期提醒（记“已联系”）：店员、店长、总部；区域经理只看 */
export function canFollowUpReminders(role: Role): boolean {
  return role === "STAFF" || role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能手动生成到期提醒：店长（本店）、总部 */
export function canRunReminderScan(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

/** 谁能看成本（机器成本、商品参考成本、销售明细成本）：店长、区域经理、总部；店员拿到的数据里就是 0（2026-10-18 坤总定） */
export function canSeeCost(role: Role): boolean {
  return role !== "STAFF";
}

/** 谁能作废销售单：店长、总部（回收单这版不做作废，口径第 5 节） */
export function canVoidSales(role: Role): boolean {
  return role === "STORE_MANAGER" || role === "HQ";
}

export interface MenuEntry {
  key: string;
  label: string;
  href?: string; // 没有 href 的还没做成页面，先显示为灰字
}

const ROADMAP: MenuEntry = { key: "roadmap", label: "后续规划", href: "/roadmap" };
const ALERTS: MenuEntry = { key: "alerts", label: "智能提醒", href: "/alerts" };
const NOTICES: MenuEntry = { key: "notices", label: "公告", href: "/notices" };
const EMPLOYEES: MenuEntry = { key: "employees", label: "员工档案", href: "/hr/employees" };
const SCHEDULES: MenuEntry = { key: "schedules", label: "排班", href: "/hr/schedules" };
const ATTENDANCE: MenuEntry = { key: "attendance", label: "考勤打卡", href: "/hr/attendance" };
const LEAVES: MenuEntry = { key: "leaves", label: "请假", href: "/hr/leaves" };
const EXPENSES: MenuEntry = { key: "expenses", label: "费用报销", href: "/finance/expenses" };
const PAYROLL: MenuEntry = { key: "payroll", label: "工资条", href: "/hr/payroll" };

const MENU_STAFF: MenuEntry[] = [
  { key: "m-sale", label: "手机开单", href: "/m/sale" },
  { key: "m-stock", label: "手机查库存", href: "/m/stock" },
  { key: "sales-new", label: "开单", href: "/sales/new" },
  { key: "stock", label: "查库存", href: "/stock" },
  { key: "products", label: "商品查价", href: "/products" },
  { key: "customers", label: "客户", href: "/customers" },
  { key: "entitlements", label: "到期名单", href: "/entitlements" },
  ALERTS,
  NOTICES,
  ATTENDANCE,
  LEAVES,
  EXPENSES,
  PAYROLL,
  { key: "repairs", label: "售后维修", href: "/repairs" },
  { key: "carrier", label: "运营商业务", href: "/carrier" },
  { key: "subsidy", label: "国补", href: "/subsidy" },
  { key: "invoices", label: "发票", href: "/invoices" },
  { key: "approvals", label: "审批", href: "/approvals" },
  { key: "sales-list", label: "我的订单", href: "/sales" },
  { key: "trade-ins", label: "回收", href: "/trade-ins" },
  { key: "stocktakes", label: "盘点", href: "/stocktakes" },
  ROADMAP,
];

// 菜单 key 与 docs/页面清单.md 的路由一一对应，后面逐页做成真链接。
const MENU_STORE_MANAGER: MenuEntry[] = [
  { key: "dashboard", label: "看板", href: "/dashboard" },
  ...MENU_STAFF.filter((m) => !["sales-list", "stocktakes", "trade-ins", "roadmap"].includes(m.key)),
  { key: "sales-list", label: "门店订单", href: "/sales" },
  { key: "transfers", label: "调拨", href: "/transfers" },
  { key: "stocktakes", label: "盘点", href: "/stocktakes" },
  { key: "trade-ins", label: "回收", href: "/trade-ins" },
  { key: "daily-close", label: "日结", href: "/daily-close" },
  { key: "prices", label: "门店售价", href: "/products/prices" },
  { key: "reports", label: "收银日报", href: "/reports/cashier" },
  EMPLOYEES,
  SCHEDULES,
  ROADMAP,
];

const MENU_REGIONAL: MenuEntry[] = [
  { key: "dashboard", label: "看板", href: "/dashboard" },
  ALERTS,
  NOTICES,
  EMPLOYEES,
  SCHEDULES,
  ATTENDANCE,
  LEAVES,
  EXPENSES,
  PAYROLL,
  { key: "stores", label: "辖区门店", href: "/stores" },
  { key: "stock", label: "库存", href: "/stock" },
  { key: "m-stock", label: "手机查库存", href: "/m/stock" },
  { key: "reports", label: "收银日报", href: "/reports/cashier" },
  { key: "entitlements", label: "到期名单", href: "/entitlements" },
  { key: "repairs", label: "售后维修", href: "/repairs" },
  { key: "carrier", label: "运营商业务", href: "/carrier" },
  { key: "subsidy", label: "国补", href: "/subsidy" },
  { key: "invoices", label: "发票", href: "/invoices" },
  { key: "approvals", label: "审批", href: "/approvals" },
  ROADMAP,
];

const MENU_HQ: MenuEntry[] = [
  { key: "dashboard", label: "看板", href: "/dashboard" },
  ALERTS,
  NOTICES,
  { key: "org", label: "组织管理", href: "/org" },
  EMPLOYEES,
  SCHEDULES,
  ATTENDANCE,
  LEAVES,
  EXPENSES,
  PAYROLL,
  { key: "products", label: "商品", href: "/products" },
  { key: "prices", label: "门店售价", href: "/products/prices" },
  { key: "purchase", label: "采购入库", href: "/purchase" },
  { key: "stock", label: "库存", href: "/stock" },
  { key: "transfers", label: "调拨", href: "/transfers" },
  { key: "stocktakes", label: "盘点", href: "/stocktakes" },
  { key: "sales-new", label: "开单", href: "/sales/new" },
  { key: "sales-list", label: "销售", href: "/sales" },
  { key: "customers", label: "客户", href: "/customers" },
  { key: "entitlements", label: "到期名单", href: "/entitlements" },
  { key: "repairs", label: "售后维修", href: "/repairs" },
  { key: "carrier", label: "运营商业务", href: "/carrier" },
  { key: "subsidy", label: "国补", href: "/subsidy" },
  { key: "invoices", label: "发票", href: "/invoices" },
  { key: "approvals", label: "审批", href: "/approvals" },
  { key: "trade-ins", label: "回收", href: "/trade-ins" },
  { key: "daily-close", label: "日结", href: "/daily-close" },
  { key: "reports", label: "收银日报", href: "/reports/cashier" },
  { key: "kpi", label: "KPI 目标", href: "/kpi" },
  { key: "logs", label: "操作日志", href: "/logs" },
  ROADMAP,
];

const WECOM_SIDEBAR: MenuEntry = { key: "wecom-sidebar", label: "企微侧边栏", href: "/wecom/sidebar" };
const WECOM_TRANSFERS: MenuEntry = { key: "wecom-transfers", label: "客户继承", href: "/wecom/transfers" };

/** 在“后续规划”前面插几项 */
function beforeRoadmap(menu: MenuEntry[], extra: MenuEntry[]): MenuEntry[] {
  const at = menu.findIndex((m) => m.key === "roadmap");
  return [...menu.slice(0, at), ...extra, ...menu.slice(at)];
}

/**
 * 登录后左侧菜单。options.wecom：企业微信对接开着（真对接或演示里的模拟）时，总部多一个“企微对接”，
 * 店员、店长多一个“企微侧边栏”，店长再多一个“客户继承”（口径第 12 节第三步）
 */
export function getMenuForRole(role: Role, options: { wecom?: boolean } = {}): MenuEntry[] {
  if (role === "HQ" && options.wecom) {
    const logsAt = MENU_HQ.findIndex((m) => m.key === "logs");
    return [...MENU_HQ.slice(0, logsAt), { key: "wecom", label: "企微对接", href: "/wecom" }, ...MENU_HQ.slice(logsAt)];
  }
  if (options.wecom && role === "STAFF") return beforeRoadmap(MENU_STAFF, [WECOM_SIDEBAR]);
  if (options.wecom && role === "STORE_MANAGER") return beforeRoadmap(MENU_STORE_MANAGER, [WECOM_SIDEBAR, WECOM_TRANSFERS]);
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
