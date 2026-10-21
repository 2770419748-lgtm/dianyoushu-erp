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
  "/entitlements": "到期名单",
  "/repairs": "售后维修",
  "/repairs/new": "售后接件",
  "/carrier": "运营商业务",
  "/carrier/new": "登记运营商业务",
  "/carrier/stats": "运营商业务统计",
  "/carrier/settlements": "运营商结算对账",
  "/carrier/rules": "运营商佣金政策",
  "/subsidy": "国补",
  "/subsidy/policies": "国补政策",
  "/invoices": "发票",
  "/invoices/new": "申请开票",
  "/invoices/seller": "公司开票信息",
  "/approvals": "审批",
  "/approvals/rules": "审批规则",
  "/wecom": "企微对接",
  "/wecom/sidebar": "企微侧边栏",
  "/wecom/kf": "微信客服",
  "/wecom/transfers": "客户继承",
  "/alerts": "智能提醒",
  "/notices": "公告",
  "/hr": "人事",
  "/hr/employees": "员工档案",
  "/hr/schedules": "排班",
  "/hr/attendance": "考勤打卡",
  "/hr/leaves": "请假",
  "/finance": "财务",
  "/finance/expenses": "费用报销",
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
const NO_PAGE = new Set(["/stock/devices", "/m", "/reports", "/hr", "/finance"]);

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
