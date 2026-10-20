"use server";

import { cookies } from "next/headers";
import { claimFromSidebar, SidebarError, sidebarUserFromToken } from "@/server/wecom/sidebar-service";
import { SIDEBAR_COOKIE } from "@/server/wecom/sidebar-token";

// 侧边栏唯一的写操作：认领绑定。只认侧边栏的票，不认 ERP 登录。
export async function claimCustomerAction(externalUserid: unknown, phone: unknown): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const user = await sidebarUserFromToken((await cookies()).get(SIDEBAR_COOKIE)?.value);
  if (!user) return { ok: false, error: "侧边栏登录过期了，重新打开一下" };
  try {
    const result = await claimFromSidebar(user, externalUserid, phone);
    return { ok: true, name: result.name };
  } catch (error) {
    if (error instanceof SidebarError) return { ok: false, error: error.message };
    throw error;
  }
}
