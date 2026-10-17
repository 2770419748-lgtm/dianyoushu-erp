// 路由与中文标题的对照，面包屑和页面标题都从这里取。纯数据，客户端服务端都能用。

export const ROUTE_TITLES: Record<string, string> = {
  "/": "首页",
  "/org": "组织管理",
  "/stores": "门店",
  "/logs": "操作日志",
  "/products": "商品",
  "/products/catalog": "品类与品牌",
  "/products/prices": "门店售价",
  "/purchase": "采购单",
  "/purchase/new": "新建采购单",
  "/stock": "库存",
  "/stock/ledger": "库存流水",
  "/stock/devices": "串号",
  "/transfers": "调拨单",
  "/transfers/new": "新建调拨",
  "/stocktakes": "盘点",
  "/customers": "客户",
  "/sales": "销售单",
  "/sales/new": "开单",
  "/trade-ins": "回收单",
  "/trade-ins/new": "新建回收单",
  "/trade-ins/stock": "回收库存",
  "/daily-close": "日结",
  "/reports": "报表",
  "/reports/cashier": "收银日报",
  "/dashboard": "看板",
  "/m": "手机端",
  "/m/sale": "手机开单",
  "/m/stock": "手机查库存",
  "/kpi": "KPI 目标",
  "/roadmap": "后续规划",
  "/me": "个人信息",
};

/** 只是路径中间的一级、本身没有页面的地址：面包屑上显示文字但不做链接（点了会 404） */
const NO_PAGE = new Set(["/stock/devices", "/m", "/reports"]);

/** 路径里通用的最后一段（如 /sales/12/return） */
const SEGMENT_TITLES: Record<string, string> = { return: "退货", edit: "编辑", new: "新建" };

export interface BreadcrumbEntry {
  href?: string; // 最后一级没有链接
  title: string;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 由当前路径算出面包屑：首页 / 一级 / 详情 */
export function breadcrumbFor(pathname: string): BreadcrumbEntry[] {
  const items: BreadcrumbEntry[] = [{ href: "/", title: ROUTE_TITLES["/"] }];
  if (pathname === "/") return [{ title: ROUTE_TITLES["/"] }];

  const segments = pathname.split("/").filter(Boolean);
  let acc = "";
  segments.forEach((segment, index) => {
    acc += `/${segment}`;
    const isLast = index === segments.length - 1;
    const known = ROUTE_TITLES[acc];
    const parent = acc.slice(0, acc.length - segment.length - 1);
    // 机器详情的最后一段是码本身（IMEI 全是数字、SN 有字母），统一显示码，不把 IMEI 显示成“详情”
    const title = known ?? SEGMENT_TITLES[segment] ?? (parent === "/stock/devices" ? safeDecode(segment) : /^\d+$/.test(segment) ? "详情" : segment);
    items.push(isLast || NO_PAGE.has(acc) ? { title } : { href: acc, title });
  });
  return items;
}
