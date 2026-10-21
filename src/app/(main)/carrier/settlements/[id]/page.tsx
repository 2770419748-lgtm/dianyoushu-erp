import { notFound } from "next/navigation";
import { isDbId, toDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageCarrier } from "@/server/auth/permissions";
import { getSettlement } from "@/server/carrier/carrier-service";
import { SettlementDetailView } from "./settlement-detail-view";

export const dynamic = "force-dynamic";

// 一张运营商结算单的对账结果：对上的、金额不符的、我们没登记的、运营商漏给的。
export default async function CarrierSettlementPage({ params }: PageProps<"/carrier/settlements/[id]">) {
  const user = await requireUser();
  if (!canManageCarrier(user.role)) return <NoAccess subTitle="运营商结算对账只有总部能做。" />;
  const id = toDbId((await params).id);
  if (!isDbId(id)) notFound();
  const detail = await getSettlement(user, id);
  if (!detail) notFound();
  return <SettlementDetailView detail={detail} />;
}
