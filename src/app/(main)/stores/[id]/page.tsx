import { notFound } from "next/navigation";
import { isDbId, toDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { getStoreInScope, type StoreDetail } from "@/server/org/store-query";
import { StoreDetailView } from "./store-detail-view";

export const dynamic = "force-dynamic";

type LoadResult = { kind: "ok"; store: StoreDetail } | { kind: "forbidden" } | { kind: "missing" };

// 越权访问（比如店员改地址栏里的 id 看别家店）由服务层抛 PermissionError，这里转成无权限页。
async function loadStore(user: CurrentUser, storeId: number): Promise<LoadResult> {
  try {
    const store = await getStoreInScope(user, storeId);
    return store ? { kind: "ok", store } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    throw error;
  }
}

export default async function StoreDetailPage({ params }: PageProps<"/stores/[id]">) {
  const { id } = await params;
  const storeId = toDbId(id);
  if (!isDbId(storeId)) notFound();

  const user = await requireUser();
  const result = await loadStore(user, storeId);
  if (result.kind === "missing") notFound();
  if (result.kind === "forbidden") return <NoAccess title="没有权限看这家门店" />;
  return <StoreDetailView store={result.store} />;
}
