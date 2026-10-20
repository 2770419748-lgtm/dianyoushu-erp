import "server-only";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { WECOM_REQUIRED_ENV, wecomMode } from "./config";

// 企微对接页（总部）：现在是真对接还是模拟、配置齐不齐（只说缺哪项，不显示值）、绑了多少客户、最近的回调事件。

export async function getWecomOverview(user: CurrentUser) {
  if (user.role !== "HQ") throw new PermissionError("企微对接页只有总部能看");
  const mode = wecomMode();
  const now = new Date();
  const [boundCustomers, follows, unboundFollows, activeCodes, staffTotal, staffBound, events] = await Promise.all([
    prisma.customer.count({ where: { wecomExternalUserid: { not: null } } }),
    prisma.wecomFollow.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.wecomFollow.count({ where: { customerId: null, status: "ACTIVE" } }),
    prisma.wecomBindCode.count({ where: { usedAt: null, expiresAt: { gt: now } } }),
    prisma.user.count({ where: { isActive: true, role: { in: ["STAFF", "STORE_MANAGER"] } } }),
    prisma.user.count({ where: { isActive: true, role: { in: ["STAFF", "STORE_MANAGER"] }, wecomUserid: { not: null } } }),
    prisma.wecomEvent.findMany({ orderBy: { id: "desc" }, take: 20 }),
  ]);
  return {
    mode,
    missingConfig: mode === "real" ? WECOM_REQUIRED_ENV.filter((key) => !process.env[key]) : [],
    counts: {
      boundCustomers,
      activeFollows: follows.find((f) => f.status === "ACTIVE")?._count._all ?? 0,
      deletedFollows: follows.find((f) => f.status === "DELETED")?._count._all ?? 0,
      unboundFollows,
      activeCodes,
      staffTotal,
      staffBound,
    },
    events: events.map((e) => ({
      id: e.id,
      receivedAt: e.receivedAt,
      eventType: e.eventType,
      changeType: e.changeType,
      simulated: e.simulated,
      status: e.status,
      result: (e.payload as Record<string, string>)._result ?? null,
      error: e.error,
    })),
  };
}

export type WecomOverview = Awaited<ReturnType<typeof getWecomOverview>>;
