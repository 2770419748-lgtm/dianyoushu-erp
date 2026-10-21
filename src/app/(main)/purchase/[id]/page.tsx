import { notFound } from "next/navigation";
import { isDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { canManagePurchase } from "@/server/auth/permissions";
import { PermissionError } from "@/server/auth/scope";
import { getPurchaseOrder, type PurchaseOrderDetail } from "@/server/purchase/purchase-service";
import { PurchaseDetailView } from "./purchase-detail-view";

export const dynamic = "force-dynamic";

type Loaded = { kind: "ok"; order: PurchaseOrderDetail } | { kind: "forbidden" } | { kind: "missing" };

async function load(user: CurrentUser, id: number): Promise<Loaded> {
  try {
    const order = await getPurchaseOrder(user, id);
    return order ? { kind: "ok", order } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    throw error;
  }
}

export default async function PurchaseDetailPage({ params }: PageProps<"/purchase/[id]">) {
  const { id } = await params;
  const orderId = Number(id);
  if (!isDbId(orderId)) notFound();

  const user = await requireUser();
  const loaded = await load(user, orderId);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这张采购单" />;
  return <PurchaseDetailView order={loaded.order} canManage={canManagePurchase(user.role)} />;
}
