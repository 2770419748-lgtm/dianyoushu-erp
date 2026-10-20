import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageApprovalRules } from "@/server/auth/permissions";
import { listRules } from "@/server/approval/approval-service";
import { RulesView } from "./rules-view";

export const dynamic = "force-dynamic";

// 审批规则（口径第 17 节）：每个场景一条，默认全关，总部按需打开、配门槛和谁批。
export default async function ApprovalRulesPage() {
  const user = await requireUser();
  if (!canManageApprovalRules(user.role)) return <NoAccess subTitle="审批规则只有总部能改。" />;
  return <RulesView rules={await listRules()} />;
}
