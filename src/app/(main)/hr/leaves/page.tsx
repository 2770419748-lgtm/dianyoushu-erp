import type { OaStatusKey } from "@/lib/attendance";
import { bjDateKey } from "@/lib/attendance";
import { requireUser } from "@/server/auth/current-user";
import { listLeaves, type LeaveView } from "@/server/hr/leave-service";
import { LeavesView } from "./leaves-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const STATUSES: OaStatusKey[] = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];

// 请假（口径第 19 节）：每个人提交、撤回自己的；店长看本店、区域经理看辖区、总部看全部；审批在“审批”里批。
export default async function LeavesPage({ searchParams }: PageProps<"/hr/leaves">) {
  const user = await requireUser();
  const params = await searchParams;
  const status = STATUSES.find((s) => s === one(params.status));
  const data = await listLeaves(user, { view: one(params.view) as LeaveView, month: one(params.month) || undefined, status, page: Number(one(params.page)) || 1 });
  return <LeavesView data={data} status={status} month={one(params.month) || null} today={bjDateKey(new Date())} />;
}
