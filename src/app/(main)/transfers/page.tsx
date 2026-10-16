import { requireUser } from "@/server/auth/current-user";
import { canManageTransfer } from "@/server/auth/permissions";
import { listTransfers } from "@/server/transfer/transfer-service";
import { TransferListView } from "./transfer-list-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 调拨单列表：看发出店或收货店在自己范围内的单。
export default async function TransfersPage({ searchParams }: PageProps<"/transfers">) {
  const user = await requireUser();
  const params = await searchParams;
  const data = await listTransfers(user, Number(one(params.page)) || 1);
  return <TransferListView rows={data.rows} total={data.total} page={data.page} pageSize={data.pageSize} canManage={canManageTransfer(user.role)} />;
}
