import { requireUser } from "@/server/auth/current-user";
import { canManageProducts } from "@/server/auth/permissions";
import { listCatalog, searchSkus } from "@/server/products/product-service";
import { ProductsView } from "./products-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 商品列表：所有角色能搜能看（查价），只有总部能新增、编辑、停用。
export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const user = await requireUser();
  const params = await searchParams;
  const query = {
    q: one(params.q),
    categoryId: Number(one(params.categoryId)) || undefined,
    brandId: Number(one(params.brandId)) || undefined,
    page: Number(one(params.page)) || 1,
    includeInactive: canManageProducts(user.role) && one(params.all) === "1",
    includeCost: canManageProducts(user.role),
  };
  const [result, catalog] = await Promise.all([searchSkus(query), listCatalog()]);
  return (
    <ProductsView
      rows={result.rows}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      query={query}
      catalog={catalog}
      canManage={canManageProducts(user.role)}
    />
  );
}
