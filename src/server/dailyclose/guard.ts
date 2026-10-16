import type { Prisma } from "@/generated/prisma/client";

// 开单、退货前调：当天已经日结确认就不让再动收银（总部撤销日结后才能补单）。
export const DAY_CLOSED_MESSAGE = "今天这家店已经日结确认了，不能再开单或退货；确实要补单请总部先撤销日结";

export async function isDayClosed(tx: Prisma.TransactionClient, storeId: number, bizDate: Date): Promise<boolean> {
  const close = await tx.dailyClose.findUnique({ where: { storeId_bizDate: { storeId, bizDate } }, select: { status: true } });
  return close?.status === "CONFIRMED";
}
