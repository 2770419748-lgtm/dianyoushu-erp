import { requireUser } from "@/server/auth/current-user";
import { listStoresInScope } from "@/server/org/store-query";
import { StoresView } from "./stores-view";

export const dynamic = "force-dynamic";

// 门店列表（只读）：每个角色只看到自己范围内的门店，过滤在服务层做。
export default async function StoresPage() {
  const user = await requireUser();
  const stores = await listStoresInScope(user);
  return <StoresView stores={stores} />;
}
