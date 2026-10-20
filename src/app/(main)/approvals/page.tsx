import type { ApprovalStatus } from "@/generated/prisma/enums";
import { requireUser } from "@/server/auth/current-user";
import { listApprovals, type ApprovalView } from "@/server/approval/approval-service";
import { ApprovalsView } from "./approvals-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const VIEWS: ApprovalView[] = ["todo", "mine", "all"];
const STATUSES: ApprovalStatus[] = ["PENDING", "EXECUTED", "FAILED", "REJECTED", "CANCELLED"];

// 审批（口径第 17 节）：待我审批（店长、总部默认看这个）、我发起的、全部（按范围）。
export default async function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  const user = await requireUser();
  const params = await searchParams;
  const data = await listApprovals(user, {
    view: VIEWS.find((v) => v === one(params.view)),
    status: STATUSES.find((s) => s === one(params.status)),
    page: Number(one(params.page)) || 1,
  });
  return <ApprovalsView data={data} status={STATUSES.find((s) => s === one(params.status))} canDecide={user.role === "STORE_MANAGER" || user.role === "HQ"} />;
}
