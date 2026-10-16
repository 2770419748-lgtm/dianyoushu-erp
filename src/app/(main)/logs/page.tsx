import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageOrg } from "@/server/auth/permissions";
import { listAuditLogs } from "@/server/audit-query";
import { LogsView } from "./logs-view";

export const dynamic = "force-dynamic";

// 操作日志：谁、什么时候、做了什么、对哪条记录。只有总部能看。
export default async function LogsPage({ searchParams }: PageProps<"/logs">) {
  const user = await requireUser();
  if (!canManageOrg(user.role)) return <NoAccess />;

  const { page } = await searchParams;
  const pageNo = Number(Array.isArray(page) ? page[0] : page) || 1;
  const data = await listAuditLogs(pageNo);
  return <LogsView rows={data.rows} total={data.total} current={data.current} pageSize={data.pageSize} />;
}
