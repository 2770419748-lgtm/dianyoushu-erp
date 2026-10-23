import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageProducts } from "@/server/auth/permissions";
import { existingSkuKeys } from "@/server/products/library-service";
import { LibraryView } from "./library-view";

export const dynamic = "force-dynamic";

// 从内置机型库添加商品（口径第 22 节）：按品牌看型号，勾颜色、容量，改指导价，一次建好。只有总部。
export default async function LibraryPage() {
  const user = await requireUser();
  if (!canManageProducts(user.role)) return <NoAccess />;
  return <LibraryView existing={await existingSkuKeys()} />;
}
