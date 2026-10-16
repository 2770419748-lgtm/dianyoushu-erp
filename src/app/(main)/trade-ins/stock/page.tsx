import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canRefurbish } from "@/server/auth/permissions";
import { listRecycledDevices } from "@/server/tradein/trade-in-service";
import { RecycledStockView } from "./recycled-stock-view";

export const dynamic = "force-dynamic";

// 回收库存：回收机（待检测）和已转良品的机器；店长、总部能转良品。
export default async function RecycledStockPage() {
  const user = await requireUser();
  if (user.role === "STAFF") return <NoAccess title="回收机转良品要店长或总部" />;
  const rows = await listRecycledDevices(user);
  return <RecycledStockView rows={rows} canRefurbish={canRefurbish(user.role)} />;
}
