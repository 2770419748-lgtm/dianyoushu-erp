"use server";

import { requireUser } from "@/server/auth/current-user";
import { runProductAction } from "@/server/products/action-result";
import * as products from "@/server/products/product-service";

export async function createSkuAction(input: products.SkuInput) {
  const user = await requireUser();
  return runProductAction(() => products.createSku(user, input));
}

export async function updateSkuAction(id: number, input: products.SkuInput) {
  const user = await requireUser();
  return runProductAction(() => products.updateSku(user, id, input));
}

export async function setSkuActiveAction(id: number, isActive: boolean) {
  const user = await requireUser();
  return runProductAction(() => products.setSkuActive(user, id, isActive));
}
