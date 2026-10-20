import { requireUser } from "@/server/auth/current-user";
import { listStoresInScope } from "@/server/org/store-query";
import { listExpiringEntitlements } from "@/server/entitlement/entitlement-service";
import { EntitlementsView } from "./entitlements-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 到期名单：碎屏险、延保快到期的客户，按“剩 0～7 天”“剩 8～30 天”两档看。
// 店员、店长看本店，区域经理看辖区（只读），总部看全部；规则在服务层。
export default async function EntitlementsPage({ searchParams }: PageProps<"/entitlements">) {
  const user = await requireUser();
  const params = await searchParams;
  const stage = one(params.stage) === "T30" ? "T30" : "T7";
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : undefined;
  const mine = one(params.mine) === "1";
  const data = await listExpiringEntitlements(user, { stage, storeId, mine, page: Number(one(params.page)) || 1 });
  return (
    <EntitlementsView
      data={data}
      stage={stage}
      stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      storeId={storeId}
      mine={mine}
    />
  );
}
