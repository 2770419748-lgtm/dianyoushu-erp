import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canTransferWecomCustomer } from "@/server/auth/permissions";
import { wecomMode } from "@/server/wecom/config";
import { getTransferPage } from "@/server/wecom/transfer-service";
import { TransfersView } from "./transfers-view";

export const dynamic = "force-dynamic";

// 客户继承（口径第 12 节第三步，店长本店、总部）：离职员工的客户安排接手人、在职转接和离职继承的进度、查进度。
export default async function WecomTransfersPage() {
  const mode = wecomMode();
  if (mode === "off") notFound();
  const user = await requireUser();
  if (!canTransferWecomCustomer(user.role)) return <NoAccess title="客户继承只有店长和总部能看" />;
  return <TransfersView mode={mode} data={await getTransferPage(user)} />;
}
