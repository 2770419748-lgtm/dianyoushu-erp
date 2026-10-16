import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export interface AuditInput {
  userId: number | null;
  action: string; // 如 login、logout、region.create、user.deactivate
  entity?: string; // 对象名，如 region、store、user
  entityId?: number | string;
  detail?: Prisma.InputJsonValue; // 改了什么，放可读的小对象
  ip?: string;
}

// 操作日志：谁、什么时候、做了什么、对哪条记录。传 tx 就和业务写入放同一个事务。
export async function writeAudit(input: AuditInput, tx?: Prisma.TransactionClient): Promise<void> {
  const client = tx ?? prisma;
  await client.auditLog.create({
    data: {
      userId: input.userId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId === undefined ? undefined : String(input.entityId),
      detail: input.detail,
      ip: input.ip,
    },
  });
}
