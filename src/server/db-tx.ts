import type { Prisma, PrismaClient } from "@/generated/prisma/client";

// 服务函数可以传 db：平时是全局 prisma，测试里传事务（跑完回滚）。
// 判断是不是事务用 "$connect" in db：事务客户端上也有 $transaction，拿它判断会在事务里再开一个新事务，卡死。

export type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

/** 传进来的是客户端就开事务，已经是事务就直接用 */
export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return "$connect" in db ? db.$transaction(fn, { timeout: 20000 }) : fn(db);
}

/** 写操作日志时：在事务里就跟着事务写 */
export function asTx(db: Db): Tx | undefined {
  return "$connect" in db ? undefined : db;
}
