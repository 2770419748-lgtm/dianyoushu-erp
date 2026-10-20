import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canHandleCarrier } from "@/server/auth/permissions";
import { listCommissionRules } from "@/server/carrier/carrier-service";
import { listStoresInScope } from "@/server/org/store-query";
import { CarrierRegisterForm } from "./carrier-register-form";

export const dynamic = "force-dynamic";

// 登记运营商业务（口径第 14 节）：店员店长登记本店的，总部选门店；佣金按当前政策预计。
export default async function NewCarrierBusinessPage() {
  const user = await requireUser();
  if (!canHandleCarrier(user.role)) return <NoAccess />;
  const stores = (await listStoresInScope(user)).filter((s) => s.isActive);
  if (stores.length === 0) return <NoAccess title="你没有可登记的门店" />;
  const rules = (await listCommissionRules()).filter((r) => r.isActive).map((r) => ({ carrier: r.carrier, bizType: r.bizType, commissionFen: r.commissionFen, clawbackMonths: r.clawbackMonths }));
  return <CarrierRegisterForm stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} defaultStoreId={user.storeId ?? stores[0]!.id} rules={rules} />;
}
