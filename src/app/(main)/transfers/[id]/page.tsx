import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { canManageTransfer } from "@/server/auth/permissions";
import { PermissionError } from "@/server/auth/scope";
import { getTransfer, type TransferDetail } from "@/server/transfer/transfer-service";
import { TransferDetailView } from "./transfer-detail-view";

export const dynamic = "force-dynamic";

type Loaded = { kind: "ok"; order: TransferDetail } | { kind: "forbidden" } | { kind: "missing" };

async function load(user: CurrentUser, id: number): Promise<Loaded> {
  try {
    const order = await getTransfer(user, id);
    return order ? { kind: "ok", order } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    throw error;
  }
}

export default async function TransferDetailPage({ params }: PageProps<"/transfers/[id]">) {
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) notFound();
  const user = await requireUser();
  const loaded = await load(user, orderId);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这张调拨单" />;
  return <TransferDetailView order={loaded.order} canManage={canManageTransfer(user.role)} />;
}
