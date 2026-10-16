import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageProducts } from "@/server/auth/permissions";
import { listCatalog } from "@/server/products/product-service";
import { CatalogView } from "./catalog-view";

export const dynamic = "force-dynamic";

// 品类、品牌、型号的维护页，只有总部能进。
export default async function CatalogPage() {
  const user = await requireUser();
  if (!canManageProducts(user.role)) return <NoAccess />;
  const catalog = await listCatalog();
  return <CatalogView catalog={catalog} />;
}
