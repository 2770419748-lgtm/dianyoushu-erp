"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { ProductError } from "@/server/products/product-service";
import { addFromLibrary, type LibraryPick } from "@/server/products/library-service";

// 从内置机型库添加商品（口径第 22 节），规则在服务层。

export async function addFromLibraryAction(picks: LibraryPick[]): Promise<{ ok: true; created: number; skipped: number } | { ok: false; error: string }> {
  const user = await requireWritableUser();
  try {
    const r = await addFromLibrary(user, picks);
    for (const path of ["/products", "/products/library", "/products/catalog", "/setup"]) revalidatePath(path);
    return { ok: true, ...r };
  } catch (error) {
    if (error instanceof ProductError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "添加失败，请稍后再试" };
  }
}
