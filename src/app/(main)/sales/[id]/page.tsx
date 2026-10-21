import { notFound } from "next/navigation";
import { isDbId, toDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { canSell, canVoidSales } from "@/server/auth/permissions";
import { PermissionError } from "@/server/auth/scope";
import { getSalesOrder, type SalesOrderDetail } from "@/server/sales/sales-service";
import { SalesDetailView } from "./sales-detail-view";
import { getOrderWecomCard } from "@/server/wecom/contact-service";
import { WecomOrderCard } from "./wecom-card";

export const dynamic = "force-dynamic";

type Loaded = { kind: "ok"; order: SalesOrderDetail } | { kind: "forbidden" } | { kind: "missing" };

async function load(user: CurrentUser, id: number): Promise<Loaded> {
  try {
    const order = await getSalesOrder(user, id);
    return order ? { kind: "ok", order } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    throw error;
  }
}

export default async function SalesDetailPage({ params }: PageProps<"/sales/[id]">) {
  const { id } = await params;
  const orderId = toDbId(id);
  if (!isDbId(orderId)) notFound();
  const user = await requireUser();
  const loaded = await load(user, orderId);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这张销售单" />;
  const wecomCard = await getOrderWecomCard(user, orderId).catch(() => null); // 企业微信卡片出错不影响看单
  return (
    <div style={{ display: "grid", gap: 24 }}>
      <SalesDetailView order={loaded.order} canVoid={canVoidSales(user.role)} canSell={canSell(user.role)} showCost={user.role !== "STAFF"} />
      {wecomCard ? <WecomOrderCard salesOrderId={orderId} card={wecomCard} /> : null}
    </div>
  );
}
