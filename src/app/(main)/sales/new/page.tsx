import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canSell } from "@/server/auth/permissions";
import { listStoresInScope } from "@/server/org/store-query";
import { listSellableAccessories } from "@/server/sales/sales-service";
import { listAvailableTradeIns, listTradeInSkuOptions } from "@/server/tradein/trade-in-service";
import { SaleForm } from "./sale-form";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 开单：店员店长只能开本店，总部选门店。
export default async function NewSalePage({ searchParams }: PageProps<"/sales/new">) {
  const user = await requireUser();
  if (!canSell(user.role)) return <NoAccess />;
  const params = await searchParams;
  const stores = (await listStoresInScope(user)).filter((s) => s.isActive);
  if (stores.length === 0) return <NoAccess title="你没有可开单的门店" />;
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : (user.storeId ?? stores[0]!.id);
  const [accessories, tradeIns, tradeInSkuOptions] = await Promise.all([
    listSellableAccessories(user, storeId),
    listAvailableTradeIns(user, storeId),
    listTradeInSkuOptions(),
  ]);
  return (
    <SaleForm
      stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      storeId={storeId}
      accessories={accessories}
      availableTradeIns={tradeIns}
      tradeInSkuOptions={tradeInSkuOptions}
    />
  );
}
