import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canSell } from "@/server/auth/permissions";
import { getCustomerDetail } from "@/server/customers/customer-service";
import { CustomerDetailView } from "./customer-detail-view";

export const dynamic = "force-dynamic";

// 客户详情：基本信息、碎屏险和延保、买过的单。店员、店长、总部能看；别人开的单只给摘要（规则在服务层）。
export default async function CustomerDetailPage({ params }: PageProps<"/customers/[id]">) {
  const { id } = await params;
  const customerId = Number(id);
  if (!Number.isInteger(customerId) || customerId <= 0) notFound();
  const user = await requireUser();
  if (!canSell(user.role)) return <NoAccess />;
  const detail = await getCustomerDetail(user, customerId);
  if (!detail) notFound();
  return <CustomerDetailView detail={detail} />;
}
