import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { readSession } from "./session";

// 同一次请求里多处调用只查一次库（react cache）。
export const getCurrentUser = cache(async () => {
  const session = await readSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      storeId: true,
      regionId: true,
      isActive: true,
      store: { select: { id: true, name: true, regionId: true } },
      region: { select: { id: true, name: true } },
    },
  });
  if (!user || !user.isActive) return null;
  return user;
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** 页面和服务层用：没登录直接跳登录页 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
