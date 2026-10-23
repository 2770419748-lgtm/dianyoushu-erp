import { requireUser } from "@/server/auth/current-user";
import { listStoresInScope } from "@/server/org/store-query";
import { canManagePurchase } from "@/server/auth/permissions";
import { docLinks } from "@/server/stock/doc-links";
import { listLedger } from "@/server/stock/stock-query";
import { LedgerView } from "./ledger-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 库存流水：每一次增减一条，按数据范围显示。
export default async function LedgerPage({ searchParams }: PageProps<"/stock/ledger">) {
  const user = await requireUser();
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : undefined;
  const q = one(params.q);
  const data = await listLedger(user, { storeId, q, page: Number(one(params.page)) || 1 });
  const links = await docLinks(data.rows.map((r) => r.docNo), { canViewPurchase: canManagePurchase(user.role), canViewImport: user.role === "HQ" });
  return <LedgerView stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} storeId={storeId} q={q} data={data} links={links} />;
}
