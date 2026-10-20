import { requireUser } from "@/server/auth/current-user";
import { carrierStats } from "@/server/carrier/carrier-service";
import { listStoresInScope } from "@/server/org/store-query";
import { todayBizDate } from "@/server/stock/doc-no";
import { CarrierStatsView } from "./carrier-stats-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 运营商业务统计（口径第 14 节）：按门店、员工、运营商、业务类型看笔数和佣金；范围同业务明细。
export default async function CarrierStatsPage({ searchParams }: PageProps<"/carrier/stats">) {
  const user = await requireUser();
  const params = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(one(params.month)) ? one(params.month) : todayBizDate().toISOString().slice(0, 7);
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : undefined;
  const stats = await carrierStats(user, { month, storeId });
  return <CarrierStatsView stats={stats} month={month} storeId={storeId} stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} isHq={user.role === "HQ"} />;
}
