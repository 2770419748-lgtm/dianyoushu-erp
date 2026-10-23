import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canRefurbish, canSell } from "@/server/auth/permissions";
import { listTradeIns } from "@/server/tradein/trade-in-service";
import { TradeInListView } from "./trade-in-list-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 回收单列表：按数据范围；店员、店长、总部能开回收单，店长和总部能转良品。
export default async function TradeInsPage({ searchParams }: PageProps<"/trade-ins">) {
  const user = await requireUser();
  if (!canSell(user.role) && user.role !== "REGIONAL_MANAGER") return <NoAccess />;
  const params = await searchParams;
  const data = await listTradeIns(user, Number(one(params.page)) || 1);
  return <TradeInListView rows={data.rows} total={data.total} page={data.page} pageSize={data.pageSize} canCreate={canSell(user.role)} canRefurbish={canRefurbish(user.role)} canSeeSellerId={data.canSeeSellerId} />;
}
