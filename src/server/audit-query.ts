import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";

export const AUDIT_PAGE_SIZE = 20;

// 操作日志只给总部看（页面层检查角色），这里只管分页查询。
export async function listAuditLogs(page: number) {
  const current = clampPage(page);
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      orderBy: { id: "desc" },
      skip: (current - 1) * AUDIT_PAGE_SIZE,
      take: AUDIT_PAGE_SIZE,
      select: {
        id: true,
        action: true,
        entity: true,
        entityId: true,
        detail: true,
        ip: true,
        createdAt: true,
        user: { select: { id: true, name: true, username: true } },
      },
    }),
    prisma.auditLog.count(),
  ]);
  return { rows, total, current, pageSize: AUDIT_PAGE_SIZE };
}

export type AuditLogRow = Awaited<ReturnType<typeof listAuditLogs>>["rows"][number];
