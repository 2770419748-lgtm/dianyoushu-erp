import { notFound } from "next/navigation";
import { isDbId, toDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManagePurchase } from "@/server/auth/permissions";
import { listActiveStoreOptions } from "@/server/org/store-query";
import { getPurchaseOrderForEdit, listSkuOptions } from "@/server/purchase/purchase-service";
import { PurchaseForm } from "../../purchase-form";

export const dynamic = "force-dynamic";

export default async function EditPurchasePage({ params }: PageProps<"/purchase/[id]/edit">) {
  const { id } = await params;
  const orderId = toDbId(id);
  if (!isDbId(orderId)) notFound();

  const user = await requireUser();
  if (!canManagePurchase(user.role)) return <NoAccess />;

  const order = await getPurchaseOrderForEdit(user, orderId);
  if (!order) notFound();
  if (order.status !== "DRAFT") return <NoAccess title="只有草稿能编辑" />;

  const [stores, skus] = await Promise.all([listActiveStoreOptions(), listSkuOptions()]);
  return <PurchaseForm stores={stores} skus={skus} initial={order} />;
}
