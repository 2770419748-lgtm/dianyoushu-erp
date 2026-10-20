import type { Carrier, CarrierBizStatus, CarrierBizType } from "@/generated/prisma/enums";
import { CARRIER_BIZ_TYPES, CARRIERS } from "@/lib/carrier";
import { requireUser } from "@/server/auth/current-user";
import { listStoresInScope } from "@/server/org/store-query";
import { listBusiness } from "@/server/carrier/carrier-service";
import { CarrierListView } from "./carrier-list-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const STATUSES: CarrierBizStatus[] = ["SUBMITTED", "ACTIVATED", "FAILED", "SETTLED", "CLAWED_BACK", "VOIDED"];

// 运营商业务明细（口径第 14 节）：店员看自己经办的，店长本店，区域经理辖区只读，总部全部。
export default async function CarrierPage({ searchParams }: PageProps<"/carrier">) {
  const user = await requireUser();
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const query = {
    status: STATUSES.find((s) => s === one(params.status)),
    carrier: CARRIERS.find((c) => c === one(params.carrier)) as Carrier | undefined,
    bizType: CARRIER_BIZ_TYPES.find((t) => t === one(params.type)) as CarrierBizType | undefined,
    month: /^\d{4}-\d{2}$/.test(one(params.month)) ? one(params.month) : undefined,
    storeId: stores.some((s) => s.id === requested) ? requested : undefined,
    q: one(params.q),
    page: Number(one(params.page)) || 1,
  };
  const data = await listBusiness(user, query);
  return <CarrierListView data={data} query={query} stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} isHq={user.role === "HQ"} />;
}
