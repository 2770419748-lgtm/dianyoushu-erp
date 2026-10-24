// 左侧菜单分两级（口径第 25 节）：一级是下面这些组，二级是各角色看得到的页面（src/server/auth/permissions.ts 的 getMenuForRole）。
// 哪一项归哪一组、组里的先后都写在这里（按菜单项的 key），四个角色一个样；某个角色在一组里一项都看不到，这组就不显示。
// 新加的菜单项要在这里归组，没归组的放到最后的“其他”里（tests/permissions.test.ts 查没有漏的）。

export interface MenuEntry {
  key: string;
  label: string;
  href?: string; // 没有 href 的还没做成页面，先显示为灰字
}

export const MENU_GROUPS = [
  { key: "work", label: "工作台", items: ["dashboard", "kpi", "alerts", "notices", "approvals"] },
  { key: "sales", label: "销售", items: ["m-sale", "sales-new", "sales-list", "trade-ins"] },
  { key: "stock", label: "库存", items: ["m-stock", "stock", "purchase", "transfers", "stocktakes"] },
  { key: "goods", label: "商品价格", items: ["products", "prices"] },
  { key: "aftersale", label: "售后", items: ["repairs", "entitlements"] },
  { key: "customer", label: "客户与企微", items: ["customers", "wecom", "wecom-sidebar", "wecom-transfers"] },
  { key: "carrier", label: "运营商与国补", items: ["carrier", "subsidy"] },
  { key: "finance", label: "财务", items: ["daily-close", "reports", "invoices", "expenses", "pnl"] },
  { key: "hr", label: "人事", items: ["employees", "schedules", "attendance", "leaves", "payroll"] },
  { key: "system", label: "系统", items: ["org", "stores", "setup", "logs", "roadmap"] },
] as const;

export interface MenuGroup {
  key: string;
  label: string;
  items: MenuEntry[];
}

/** 把一个角色的菜单按一级分组排好：组和组里的先后照 MENU_GROUPS；没有项的组不要；没归组的放进最后的“其他” */
export function groupMenu(entries: MenuEntry[]): MenuGroup[] {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const groups: MenuGroup[] = MENU_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    items: g.items.flatMap((k) => byKey.get(k) ?? []),
  }));
  const grouped = new Set<string>(MENU_GROUPS.flatMap((g) => g.items));
  groups.push({ key: "other", label: "其他", items: entries.filter((e) => !grouped.has(e.key)) });
  return groups.filter((g) => g.items.length > 0);
}
