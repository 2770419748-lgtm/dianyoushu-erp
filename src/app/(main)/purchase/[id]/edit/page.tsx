import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManagePurchase } from "@/server/auth/permissions";
import { listSkuOptions } from "@/server/purchase/purchase-service";
import { PurchaseForm } from "../../purchase-form";

export const dynamic = "force-dynamic";

export default async function EditPurchasePage({ params }: PageProps<"/purchase/[id]/edit">) {
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) notFound();

  const user = await requireUser();
  if (!canManagePurchase(user.role)) return <NoAccess />;

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, storeId: true, supplierName: true, note: true, items: { select: { skuId: true, qty: true, unitCostFen: true } } },
  });
  if (!order) notFound();
  if (order.status !== "DRAFT") return <NoAccess title="只有草稿能编辑" />;

  const [stores, skus] = await Promise.all([
    prisma.store.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    listSkuOptions(),
  ]);
  return <PurchaseForm stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} skus={skus} initial={order} />;
}
