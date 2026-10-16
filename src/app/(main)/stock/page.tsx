import { requireUser } from "@/server/auth/current-user";
import { listStoresInScope } from "@/server/org/store-query";
import { listAccessoryStocks, listDevices, stockSummary } from "@/server/stock/stock-query";
import type { DeviceStatus } from "@/generated/prisma/enums";
import { StockView } from "./stock-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const STATUSES: DeviceStatus[] = ["IN_TRANSIT", "IN_STOCK", "SOLD", "RECYCLED", "REFURBISHED", "LOCKED", "LOST"];

// 门店库存：串号库存（按机型、状态筛）和配件库存，按数据范围显示。
export default async function StockPage({ searchParams }: PageProps<"/stock">) {
  const user = await requireUser();
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : undefined;
  const statusText = one(params.status);
  const status = (STATUSES as string[]).includes(statusText) ? (statusText as DeviceStatus) : undefined;
  const q = one(params.q);
  const tab = one(params.tab) === "accessories" ? "accessories" : "devices";
  const page = Number(one(params.page)) || 1;

  const [devices, accessories, summary] = await Promise.all([
    listDevices(user, { storeId, q, status, page }),
    listAccessoryStocks(user, { storeId, q }),
    stockSummary(user, storeId),
  ]);

  return (
    <StockView
      stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      query={{ storeId, q, status, tab, page }}
      devices={devices}
      accessories={accessories}
      summary={summary}
      showCost={user.role !== "STAFF"}
    />
  );
}
