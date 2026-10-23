import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { readSession } from "./session";
import { findSessionUser } from "./session-user";

// 同一次请求里多处调用只查一次库（react cache）。
export const getCurrentUser = cache(async () => {
  const session = await readSession();
  if (!session) return null;
  return findSessionUser(session);
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** 页面和服务层用：没登录直接跳登录页 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (user) return user;
  // 有登录 cookie、但登录已失效（账号停用、密码改过、账号不存在）：带上 reason=expired 去登录页，
  // proxy 见到它不再把人弹回首页（不然两边来回跳），登录页发 POST 清掉旧 cookie（见 /api/session/clear）
  if (await readSession()) redirect("/login?reason=expired");
  redirect("/login");
}
