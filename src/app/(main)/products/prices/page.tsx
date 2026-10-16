import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManagePrices } from "@/server/auth/permissions";
import { PermissionError } from "@/server/auth/scope";
import { listStoresInScope } from "@/server/org/store-query";
import { listStorePrices } from "@/server/products/price-service";
import { ProductError } from "@/server/products/product-service";
import { PricesView } from "./prices-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

type Loaded =
  | { kind: "ok"; data: Awaited<ReturnType<typeof listStorePrices>> }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function load(user: Awaited<ReturnType<typeof requireUser>>, storeId: number, q: string): Promise<Loaded> {
  try {
    return { kind: "ok", data: await listStorePrices(user, storeId, q) };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    if (error instanceof ProductError) return { kind: "error", message: error.message };
    throw error;
  }
}

// 门店售价：看价按数据范围，改价只有店长（本店）和总部。
export default async function PricesPage({ searchParams }: PageProps<"/products/prices">) {
  const user = await requireUser();
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  if (stores.length === 0) return <NoAccess title="你没有可看的门店" />;

  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : (user.storeId ?? stores[0]!.id);
  const q = one(params.q);

  const loaded = await load(user, storeId, q);
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这家门店的售价" />;
  if (loaded.kind === "error") return <NoAccess title={loaded.message} />;

  return (
    <PricesView
      stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      storeId={storeId}
      q={q}
      rows={loaded.data.rows}
      canEdit={canManagePrices(user.role)}
    />
  );
}
