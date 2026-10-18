import "server-only";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";

// 首页底部的一行状态：数据库连得上没有。
// 全公司的门店数、员工数只给总部看；连不上时页面只显示一句话，原始报错只进服务端日志（里面可能有地址、库名）。

export type SystemStatus = { ok: true; counts?: { stores: number; users: number } } | { ok: false };

export async function getSystemStatus(user: CurrentUser): Promise<SystemStatus> {
  try {
    if (user.role !== "HQ") {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    }
    const [stores, users] = await Promise.all([prisma.store.count(), prisma.user.count()]);
    return { ok: true, counts: { stores, users } };
  } catch (error) {
    console.error("[首页] 数据库检查失败", error);
    return { ok: false };
  }
}

/** 健康检查用（/api/health，不用登录）：数据库能不能执行一条最简单的查询 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error("[健康检查] 数据库连不上", error);
    return false;
  }
}
