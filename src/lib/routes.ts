// 路由与中文标题的对照，面包屑和页面标题都从这里取。纯数据，客户端服务端都能用。

export const ROUTE_TITLES: Record<string, string> = {
  "/": "首页",
  "/org": "组织管理",
  "/stores": "门店",
  "/logs": "操作日志",
};

export interface BreadcrumbEntry {
  href?: string; // 最后一级没有链接
  title: string;
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
    const title = known ?? (/^\d+$/.test(segment) ? "详情" : segment);
    items.push(isLast ? { title } : { href: acc, title });
  });
  return items;
}
