import type { SubsidyClaimStatus } from "@/generated/prisma/enums";
import { requireUser } from "@/server/auth/current-user";
import { listStoresInScope } from "@/server/org/store-query";
import { listClaims, subsidySummary } from "@/server/subsidy/subsidy-service";
import { SubsidyView } from "./subsidy-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const STATUSES: SubsidyClaimStatus[] = ["PENDING", "SUBMITTED", "APPROVED", "SETTLED", "REJECTED", "CANCELLED", "RETURN_DUE", "RETURNED"];

// 国补订单明细（口径第 15 节）：店员店长本店、区域经理辖区（只读）、总部全部；上面按门店汇总国补应收。
export default async function SubsidyPage({ searchParams }: PageProps<"/subsidy">) {
  const user = await requireUser();
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const query = {
    status: STATUSES.find((s) => s === one(params.status)),
    storeId: stores.some((s) => s.id === requested) ? requested : undefined,
    month: /^\d{4}-\d{2}$/.test(one(params.month)) ? one(params.month) : undefined,
    q: one(params.q),
    page: Number(one(params.page)) || 1,
  };
  const [data, summary] = await Promise.all([listClaims(user, query), subsidySummary(user, { storeId: query.storeId })]);
  return <SubsidyView data={data} summary={summary} query={query} stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} />;
}
