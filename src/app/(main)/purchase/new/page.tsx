import { prisma } from "@/lib/prisma";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManagePurchase } from "@/server/auth/permissions";
import { listSkuOptions } from "@/server/purchase/purchase-service";
import { PurchaseForm } from "../purchase-form";

export const dynamic = "force-dynamic";

export default async function NewPurchasePage() {
  const user = await requireUser();
  if (!canManagePurchase(user.role)) return <NoAccess />;
  const [stores, skus] = await Promise.all([
    prisma.store.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    listSkuOptions(),
  ]);
  return <PurchaseForm stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} skus={skus} />;
}
