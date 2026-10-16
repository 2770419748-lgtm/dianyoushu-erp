import { requireUser } from "@/server/auth/current-user";
import { canEnterStocktake } from "@/server/auth/permissions";
import { listStoresInScope } from "@/server/org/store-query";
import { listStocktakes } from "@/server/stocktake/stocktake-service";
import { StocktakeListView } from "./stocktake-list-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 盘点列表 + 发起盘点（店员、店长、总部）；按数据范围显示。
export default async function StocktakesPage({ searchParams }: PageProps<"/stocktakes">) {
  const user = await requireUser();
  const params = await searchParams;
  const [data, stores] = await Promise.all([listStocktakes(user, Number(one(params.page)) || 1), listStoresInScope(user)]);
  return (
    <StocktakeListView
      rows={data.rows}
      total={data.total}
      page={data.page}
      pageSize={data.pageSize}
      stores={stores.filter((s) => s.isActive).map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      defaultStoreId={user.storeId ?? undefined}
      canCreate={canEnterStocktake(user.role)}
    />
  );
}
