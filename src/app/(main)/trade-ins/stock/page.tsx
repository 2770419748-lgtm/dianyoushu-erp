import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canRefurbish } from "@/server/auth/permissions";
import { listRecycledDevices } from "@/server/tradein/trade-in-service";
import { RecycledStockView } from "./recycled-stock-view";

export const dynamic = "force-dynamic";

// 回收库存：回收机（待检测）和已转良品的机器；店长、总部能转良品。
export default async function RecycledStockPage({ searchParams }: PageProps<"/trade-ins/stock">) {
  const user = await requireUser();
  if (user.role === "STAFF") return <NoAccess title="回收机转良品要店长或总部" />;
  const pageText = (await searchParams).page;
  const result = await listRecycledDevices(user, Number(Array.isArray(pageText) ? pageText[0] : pageText) || 1);
  return <RecycledStockView {...result} canRefurbish={canRefurbish(user.role)} />;
}
