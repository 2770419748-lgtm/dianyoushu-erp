import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canSell } from "@/server/auth/permissions";
import { listStoresInScope } from "@/server/org/store-query";
import { listTradeInSkuOptions } from "@/server/tradein/trade-in-service";
import { NewTradeInView } from "./new-trade-in-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function NewTradeInPage({ searchParams }: PageProps<"/trade-ins/new">) {
  const user = await requireUser();
  if (!canSell(user.role)) return <NoAccess />;
  const params = await searchParams;
  const stores = (await listStoresInScope(user)).filter((s) => s.isActive);
  if (stores.length === 0) return <NoAccess title="你没有可用的门店" />;
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : (user.storeId ?? stores[0]!.id);
  const skuOptions = await listTradeInSkuOptions();
  return <NewTradeInView stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} storeId={storeId} skuOptions={skuOptions} />;
}
