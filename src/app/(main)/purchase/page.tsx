import { requireUser } from "@/server/auth/current-user";
import { canManagePurchase } from "@/server/auth/permissions";
import { listPurchaseOrders } from "@/server/purchase/purchase-service";
import { PurchaseListView } from "./purchase-list-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 采购单列表：总部能看全部并新建；其他角色只看自己范围内门店的采购单。
export default async function PurchasePage({ searchParams }: PageProps<"/purchase">) {
  const user = await requireUser();
  const params = await searchParams;
  const data = await listPurchaseOrders(user, Number(one(params.page)) || 1);
  return <PurchaseListView rows={data.rows} total={data.total} page={data.page} pageSize={data.pageSize} canManage={canManagePurchase(user.role)} />;
}
