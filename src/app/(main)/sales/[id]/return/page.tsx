import { notFound } from "next/navigation";
import { isDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { canSell } from "@/server/auth/permissions";
import { PermissionError } from "@/server/auth/scope";
import { getReturnContext, type ReturnContext } from "@/server/sales/return-service";
import { ReturnForm } from "./return-form";

export const dynamic = "force-dynamic";

type Loaded = { kind: "ok"; ctx: ReturnContext } | { kind: "forbidden" } | { kind: "missing" };

async function load(user: CurrentUser, id: number): Promise<Loaded> {
  try {
    const ctx = await getReturnContext(user, id);
    return ctx ? { kind: "ok", ctx } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    throw error;
  }
}

// 退货：选原单明细退回，按原收款方式退款，以旧换新抵扣不退。
export default async function ReturnPage({ params }: PageProps<"/sales/[id]/return">) {
  const { id } = await params;
  const orderId = Number(id);
  if (!isDbId(orderId)) notFound();
  const user = await requireUser();
  if (!canSell(user.role)) return <NoAccess />;
  const loaded = await load(user, orderId);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限给这张单退货" />;
  if (loaded.ctx.order.status !== "COMPLETED") return <NoAccess title="作废的单不能退货" />;
  return <ReturnForm ctx={loaded.ctx} />;
}
