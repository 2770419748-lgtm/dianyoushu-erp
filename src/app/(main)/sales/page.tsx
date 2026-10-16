import { requireUser } from "@/server/auth/current-user";
import { canSell } from "@/server/auth/permissions";
import { listStoresInScope } from "@/server/org/store-query";
import { listSalesOrders } from "@/server/sales/sales-service";
import { SalesListView } from "./sales-list-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 销售单列表：店员只看自己开的，店长本店，区域经理辖区，总部全部。
export default async function SalesPage({ searchParams }: PageProps<"/sales">) {
  const user = await requireUser();
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : undefined;
  const data = await listSalesOrders(user, { storeId, page: Number(one(params.page)) || 1 });
  return (
    <SalesListView
      rows={data.rows}
      total={data.total}
      page={data.page}
      pageSize={data.pageSize}
      stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      storeId={storeId}
      canCreate={canSell(user.role)}
    />
  );
}
