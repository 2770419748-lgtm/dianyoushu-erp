import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canSell } from "@/server/auth/permissions";
import { listStoresInScope } from "@/server/org/store-query";
import { isStoreClosedToday } from "@/server/sales/sales-service";
import { listAvailableTradeIns, listTradeInSkuOptions } from "@/server/tradein/trade-in-service";
import { MobileSaleView } from "./mobile-sale-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 手机开单：扫码或输串号加商品，一种收款方式，一屏提交。要拆多种收款、整单优惠用电脑版开单。
export default async function MobileSalePage({ searchParams }: PageProps<"/m/sale">) {
  const user = await requireUser();
  if (!canSell(user.role)) return <NoAccess />;
  const params = await searchParams;
  const stores = (await listStoresInScope(user)).filter((s) => s.isActive);
  if (stores.length === 0) return <NoAccess title="你没有可开单的门店" />;
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : (user.storeId ?? stores[0]!.id);
  const [tradeIns, tradeInSkuOptions, dayClosed] = await Promise.all([listAvailableTradeIns(user, storeId), listTradeInSkuOptions(), isStoreClosedToday(user, storeId)]);
  return (
    <MobileSaleView
      key={storeId}
      stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      storeId={storeId}
      availableTradeIns={tradeIns}
      tradeInSkuOptions={tradeInSkuOptions}
      dayClosed={dayClosed}
    />
  );
}
