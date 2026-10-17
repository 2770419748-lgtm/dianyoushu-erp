import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManagePurchase } from "@/server/auth/permissions";
import { listActiveStoreOptions } from "@/server/org/store-query";
import { listSkuOptions } from "@/server/purchase/purchase-service";
import { PurchaseForm } from "../purchase-form";

export const dynamic = "force-dynamic";

export default async function NewPurchasePage() {
  const user = await requireUser();
  if (!canManagePurchase(user.role)) return <NoAccess />;
  const [stores, skus] = await Promise.all([listActiveStoreOptions(), listSkuOptions()]);
  return <PurchaseForm stores={stores} skus={skus} />;
}
