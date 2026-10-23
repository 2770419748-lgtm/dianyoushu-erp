import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canSell } from "@/server/auth/permissions";
import { listStoresInScope } from "@/server/org/store-query";
import { listSellableAccessories, listSellableServices } from "@/server/sales/sales-service";
import { listAvailableTradeIns, listTradeInSkuOptions } from "@/server/tradein/trade-in-service";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { subsidyHint } from "@/server/subsidy/subsidy-service";
import { SaleForm } from "./sale-form";
import { getPaymentMethods, getSwitches } from "@/server/settings/settings-service";

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
  const [accessories, services, tradeIns, tradeInSkuOptions, subsidy] = await Promise.all([
    listSellableAccessories(user, storeId),
    listSellableServices(user, storeId),
    listAvailableTradeIns(user, storeId),
    listTradeInSkuOptions(),
    subsidyHint(),
  ]);
  return (
    // key：换门店时重建，不会把别家店的机器和回收单带过来
    <SaleForm
      key={storeId}
      paymentMethods={await getPaymentMethods()}
      sellerIdRequired={(await getSwitches()).tradeInIdRequired}
      stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      storeId={storeId}
      accessories={accessories}
      services={services}
      availableTradeIns={tradeIns}
      tradeInSkuOptions={tradeInSkuOptions}
      subsidyHint={subsidy}
      demo={DEMO_MODE}
    />
  );
}
