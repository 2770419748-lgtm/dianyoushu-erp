"use server";

import { requireWritableUser } from "@/server/license/license-service";
import { runProductAction } from "@/server/products/action-result";
import { setStorePrice } from "@/server/products/price-service";

/** priceFen 传 null 表示恢复指导价 */
export async function setStorePriceAction(storeId: number, skuId: number, priceFen: number | null) {
  const user = await requireWritableUser();
  return runProductAction(() => setStorePrice(user, storeId, skuId, priceFen));
}
