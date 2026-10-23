import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { readSession } from "./session";
import { findSessionUser } from "./session-user";

// 同一次请求里多处调用只查一次库（react cache）。
// 接口（Route Handler）直接用 getCurrentUser 的，要自己挡还没改初始密码的人（user.mustChangePassword）。
export const getCurrentUser = cache(async () => {
  const session = await readSession();
  if (!session) return null;
  return findSessionUser(session);
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/**
 * 页面和服务层用：没登录直接跳登录页。
 * 第一次登录还没改初始密码的（口径第 21 节）跳“先改密码”页，不往下查数据——以前只是布局不显示页面，
 * 页面照样在服务端跑完、数据发到了浏览器（2026-10-23 复查第 67 条）。只有主布局、“先改密码”页、改密码、看消息传 allowFirstPassword。
 */
export async function requireUser(options: { allowFirstPassword?: boolean } = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (user) {
    if (user.mustChangePassword && !options.allowFirstPassword) redirect("/first-password");
    return user;
  }
  // 有登录 cookie、但登录已失效（账号停用、密码改过、账号不存在）：带上 reason=expired 去登录页，
  // proxy 见到它不再把人弹回首页（不然两边来回跳），登录页发 POST 清掉旧 cookie（见 /api/session/clear）
  if (await readSession()) redirect("/login?reason=expired");
  redirect("/login");
}
