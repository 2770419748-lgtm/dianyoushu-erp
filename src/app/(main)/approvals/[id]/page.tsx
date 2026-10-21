import { notFound } from "next/navigation";
import { isDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { ApprovalError, getApproval } from "@/server/approval/approval-service";
import { ApprovalDetailView } from "./approval-detail-view";

export const dynamic = "force-dynamic";

// 审批单详情（口径第 17 节）：为什么要批、明细；通过、驳回、撤回；通过后做出来的单据。
export default async function ApprovalPage({ params }: PageProps<"/approvals/[id]">) {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!isDbId(id)) notFound();
  let detail;
  try {
    detail = await getApproval(user, id);
  } catch (error) {
    if (error instanceof ApprovalError) return <NoAccess subTitle={error.message} />;
    throw error;
  }
  if (!detail) notFound();
  return <ApprovalDetailView detail={detail} viewerRole={user.role} />;
}
