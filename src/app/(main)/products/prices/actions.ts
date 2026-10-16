"use server";

import { requireUser } from "@/server/auth/current-user";
import { runProductAction } from "@/server/products/action-result";
import { setStorePrice } from "@/server/products/price-service";

/** priceFen 传 null 表示恢复指导价 */
export async function setStorePriceAction(storeId: number, skuId: number, priceFen: number | null) {
  const user = await requireUser();
  return runProductAction(() => setStorePrice(user, storeId, skuId, priceFen));
}
