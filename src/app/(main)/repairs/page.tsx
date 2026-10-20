import { requireUser } from "@/server/auth/current-user";
import { listStoresInScope } from "@/server/org/store-query";
import { listRepairs, type RepairListView } from "@/server/repair/repair-service";
import { RepairsView } from "./repairs-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const VIEWS: RepairListView[] = ["open", "ready", "closed", "all"];

// 售后维修列表（口径第 13 节）：进行中 / 待取机 / 已完结 / 全部；按门店范围看，区域经理只读。
export default async function RepairsPage({ searchParams }: PageProps<"/repairs">) {
  const user = await requireUser();
  const params = await searchParams;
  const view = VIEWS.find((v) => v === one(params.view)) ?? "open";
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : undefined;
  const q = one(params.q);
  const data = await listRepairs(user, { view, storeId, q, page: Number(one(params.page)) || 1 });
  return <RepairsView data={data} view={view} q={q} stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} storeId={storeId} />;
}
