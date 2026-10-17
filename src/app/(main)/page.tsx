import type { Role } from "@/generated/prisma/enums";
import { requireUser } from "@/server/auth/current-user";
import { ROLE_LABELS } from "@/server/auth/permissions";
import { getSystemStatus } from "@/server/system-status";
import { HomeView, type QuickEntry } from "./home-view";

export const dynamic = "force-dynamic";

const E = {
  mSale: { href: "/m/sale", title: "手机开单", desc: "扫码加商品，一屏收款", primary: true },
  mStock: { href: "/m/stock", title: "查库存", desc: "扫串号看在哪家店" },
  tradeIn: { href: "/trade-ins/new", title: "收旧机", desc: "估价回收、以旧换新" },
  sale: { href: "/sales/new", title: "电脑版开单", desc: "拆分收款、整单优惠" },
  sales: { href: "/sales", title: "订单", desc: "查单、退货" },
  dailyClose: { href: "/daily-close", title: "日结", desc: "按支付方式对账" },
  dashboard: { href: "/dashboard", title: "看板", desc: "销售、毛利、KPI 完成率", primary: true },
  stock: { href: "/stock", title: "库存", desc: "串号库存、配件库存" },
  cashier: { href: "/reports/cashier", title: "收银日报", desc: "可导出" },
  purchase: { href: "/purchase", title: "采购入库", desc: "下采购单、到货录串号" },
  kpi: { href: "/kpi", title: "KPI 目标", desc: "门店 × 月目标" },
  roadmap: { href: "/roadmap", title: "后续规划", desc: "没做的模块和原因" },
} satisfies Record<string, QuickEntry>;

const ENTRIES: Record<Role, QuickEntry[]> = {
  STAFF: [E.mSale, E.mStock, E.tradeIn, E.sale, E.sales],
  STORE_MANAGER: [E.mSale, E.mStock, E.dailyClose, E.dashboard, E.tradeIn, E.sale, E.sales],
  REGIONAL_MANAGER: [E.dashboard, E.stock, E.mStock, E.cashier, E.roadmap],
  HQ: [E.dashboard, E.kpi, E.purchase, E.stock, E.cashier, E.roadmap],
};

export default async function HomePage() {
  const user = await requireUser();
  const db = await getSystemStatus(user);
  return <HomeView db={db} greeting={`你好，${user.name}（${ROLE_LABELS[user.role]}）`} entries={ENTRIES[user.role]} />;
}
