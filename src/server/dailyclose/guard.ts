import type { Prisma } from "@/generated/prisma/client";

// 开单、退货前调：当天已经日结确认就不让再动收银（总部撤销日结后才能补单）。
export const DAY_CLOSED_MESSAGE = "今天这家店已经日结确认了，不能再开单或退货；确实要补单请总部先撤销日结";

export async function isDayClosed(tx: Prisma.TransactionClient, storeId: number, bizDate: Date): Promise<boolean> {
  const close = await tx.dailyClose.findUnique({ where: { storeId_bizDate: { storeId, bizDate } }, select: { status: true } });
  return close?.status === "CONFIRMED";
}

/**
 * 给“某家店的某个营业日”加锁，同一把锁同一时间只有一个事务拿得到，事务结束（提交或回滚）自动释放。
 * 开单、作废、退货、日结保存 / 确认 / 撤销都先拿这把锁，再做检查和写入，于是它们对同一店同一天是排队执行的：
 * - 日结确认算完账之前，不会有新单插进来（否则新单不在账里却被锁进当天）；
 * - 开单拿到锁时如果日结刚确认完，检查会看到“已确认”，直接拒绝；
 * - 同一张单不会被两个人同时作废、同一行不会被同时退两次。
 * 用的是 PostgreSQL 的事务级“咨询锁”（advisory lock）：不锁任何表行，只是按两个整数排队，其他门店、其他天互不影响。
 */
export async function lockStoreDay(tx: Prisma.TransactionClient, storeId: number, bizDate: Date): Promise<void> {
  const day = Number(bizDate.toISOString().slice(0, 10).replace(/-/g, "")); // 如 20261017，放得进 32 位整数
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${storeId}::int, ${day}::int)`;
}
