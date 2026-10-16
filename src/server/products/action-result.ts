import { revalidatePath } from "next/cache";
import { ProductError } from "./product-service";

// 商品相关 Server Function 共用的包装：成功就刷新商品页面，业务错误转成提示文字。
// 这不是 "use server" 文件，所以不会被当成可从浏览器直接调用的函数。

export type ActionResult = { ok: true } | { ok: false; error: string };

const PRODUCT_PATHS = ["/products", "/products/catalog", "/products/prices"];

export async function runProductAction(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    for (const path of PRODUCT_PATHS) revalidatePath(path);
    return { ok: true };
  } catch (error) {
    if (error instanceof ProductError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}
