import { notFound } from "next/navigation";
import { isDbId, toDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { canConfirmStocktake, canEnterStocktake } from "@/server/auth/permissions";
import { PermissionError } from "@/server/auth/scope";
import { getStocktake, type StocktakeDetail } from "@/server/stocktake/stocktake-service";
import { StocktakeDetailView } from "./stocktake-detail-view";

export const dynamic = "force-dynamic";

type Loaded = { kind: "ok"; stocktake: StocktakeDetail } | { kind: "forbidden" } | { kind: "missing" };

async function load(user: CurrentUser, id: number): Promise<Loaded> {
  try {
    const stocktake = await getStocktake(user, id);
    return stocktake ? { kind: "ok", stocktake } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    throw error;
  }
}

export default async function StocktakeDetailPage({ params }: PageProps<"/stocktakes/[id]">) {
  const { id } = await params;
  const stocktakeId = toDbId(id);
  if (!isDbId(stocktakeId)) notFound();
  const user = await requireUser();
  const loaded = await load(user, stocktakeId);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这张盘点单" />;
  return <StocktakeDetailView stocktake={loaded.stocktake} canEnter={canEnterStocktake(user.role)} canConfirm={canConfirmStocktake(user.role)} />;
}
