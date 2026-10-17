import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManagePurchase } from "@/server/auth/permissions";
import { listPurchaseOrders } from "@/server/purchase/purchase-service";
import { PurchaseListView } from "./purchase-list-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 采购单列表：只有总部能看（供应商、成本单价是总部的数据，口径第 1 节）。
export default async function PurchasePage({ searchParams }: PageProps<"/purchase">) {
  const user = await requireUser();
  if (!canManagePurchase(user.role)) return <NoAccess title="采购单只有总部能看" />;
  const params = await searchParams;
  const data = await listPurchaseOrders(user, Number(one(params.page)) || 1);
  return <PurchaseListView rows={data.rows} total={data.total} page={data.page} pageSize={data.pageSize} canManage={canManagePurchase(user.role)} />;
}
