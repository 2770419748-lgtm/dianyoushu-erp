import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canHandleRepair } from "@/server/auth/permissions";
import { listStoresInScope } from "@/server/org/store-query";
import { RepairIntakeForm } from "./repair-intake-form";

export const dynamic = "force-dynamic";

// 售后接件（口径第 13 节）：选客户、扫或输机器的码、写故障。店员店长接本店的，总部选门店。
export default async function NewRepairPage() {
  const user = await requireUser();
  if (!canHandleRepair(user.role)) return <NoAccess />;
  const stores = (await listStoresInScope(user)).filter((s) => s.isActive);
  if (stores.length === 0) return <NoAccess title="你没有可接件的门店" />;
  return <RepairIntakeForm stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} defaultStoreId={user.storeId ?? stores[0]!.id} />;
}
