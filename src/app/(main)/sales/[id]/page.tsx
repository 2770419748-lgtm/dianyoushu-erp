import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { canSell, canVoidSales } from "@/server/auth/permissions";
import { PermissionError } from "@/server/auth/scope";
import { getSalesOrder, type SalesOrderDetail } from "@/server/sales/sales-service";
import { SalesDetailView } from "./sales-detail-view";

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
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) notFound();
  const user = await requireUser();
  const loaded = await load(user, orderId);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这张销售单" />;
  return <SalesDetailView order={loaded.order} canVoid={canVoidSales(user.role)} canSell={canSell(user.role)} showCost={user.role !== "STAFF"} />;
}
