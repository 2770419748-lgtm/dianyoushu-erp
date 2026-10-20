import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { getRepair, RepairError, type RepairDetail } from "@/server/repair/repair-service";
import { RepairDetailView } from "./repair-detail-view";

export const dynamic = "force-dynamic";

type Loaded = { kind: "ok"; repair: RepairDetail } | { kind: "forbidden" } | { kind: "missing" };

async function load(user: CurrentUser, id: number): Promise<Loaded> {
  try {
    const repair = await getRepair(user, id);
    return repair ? { kind: "ok", repair } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError || error instanceof RepairError) return { kind: "forbidden" };
    throw error;
  }
}

// 维修单详情（口径第 13 节）：按状态给出报价、客户同意 / 不修、修好 / 修不好、取机结算、作废。
export default async function RepairDetailPage({ params }: PageProps<"/repairs/[id]">) {
  const { id } = await params;
  const repairId = Number(id);
  if (!Number.isInteger(repairId) || repairId <= 0) notFound();
  const user = await requireUser();
  const loaded = await load(user, repairId);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这张维修单" />;
  return <RepairDetailView repair={loaded.repair} />;
}
