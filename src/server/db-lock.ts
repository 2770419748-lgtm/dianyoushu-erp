import { Prisma } from "@/generated/prisma/client";

// 单据级防并发：事务一开始先把这张单据的行锁住（SELECT ... FOR UPDATE），再重新读单据和明细做检查。
// 同一张单据的第二个操作会在这里排队，等第一个提交后再读到最新状态（比如“已发出”），检查就会拦下它。
// 两个标签页同时点“发出”、两个人同时点“确认收货”，都只会做一次。

const LOCKABLE = {
  purchase_orders: Prisma.raw('"purchase_orders"'),
  transfer_orders: Prisma.raw('"transfer_orders"'),
  stocktakes: Prisma.raw('"stocktakes"'),
  sales_orders: Prisma.raw('"sales_orders"'),
  repair_orders: Prisma.raw('"repair_orders"'),
  carrier_business: Prisma.raw('"carrier_business"'),
  subsidy_claims: Prisma.raw('"subsidy_claims"'),
  invoices: Prisma.raw('"invoices"'),
  approval_requests: Prisma.raw('"approval_requests"'),
  wecom_follows: Prisma.raw('"wecom_follows"'),
} as const;

export type LockableTable = keyof typeof LOCKABLE;

/** 锁住单据行，直到当前事务结束；单据不存在返回 false */
export async function lockRow(tx: Prisma.TransactionClient, table: LockableTable, id: number): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM ${LOCKABLE[table]} WHERE id = ${id} FOR UPDATE`;
  return rows.length > 0;
}
