"use server";

import { requireUser } from "@/server/auth/current-user";
import { runProductAction } from "@/server/products/action-result";
import * as products from "@/server/products/product-service";

export async function createCategoryAction(input: products.CategoryInput) {
  const user = await requireUser();
  return runProductAction(() => products.createCategory(user, input));
}

export async function updateCategoryAction(id: number, input: products.CategoryInput) {
  const user = await requireUser();
  return runProductAction(() => products.updateCategory(user, id, input));
}

export async function createBrandAction(input: { name: string }) {
  const user = await requireUser();
  return runProductAction(() => products.createBrand(user, input));
}

export async function updateBrandAction(id: number, input: { name: string }) {
  const user = await requireUser();
  return runProductAction(() => products.updateBrand(user, id, input));
}

export async function createModelAction(input: products.ModelInput) {
  const user = await requireUser();
  return runProductAction(() => products.createModel(user, input));
}

export async function updateModelAction(id: number, input: products.ModelInput) {
  const user = await requireUser();
  return runProductAction(() => products.updateModel(user, id, input));
}
