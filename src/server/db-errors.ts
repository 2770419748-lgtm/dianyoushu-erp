// 数据库报错的识别：Prisma 把数据库约束冲突包成带 code 的错误。
// 业务层先自己检查一遍给出好懂的提示；并发时两个请求同时通过了检查，最后由数据库约束兜底，这里把兜底的报错认出来，换成人话。

/** 唯一约束冲突（同一个码、同一张回收单被两处同时用） */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/** 检查约束冲突（比如配件余额被扣成负数） */
export function isCheckViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: string; message?: string; meta?: { code?: string } };
  return e.code === "P2004" || e.meta?.code === "23514" || /23514|violates check constraint/.test(e.message ?? "");
}
