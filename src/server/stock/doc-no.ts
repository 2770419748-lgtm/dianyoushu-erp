import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import type { Prisma } from "@/generated/prisma/client";
import { APP_TIMEZONE } from "@/lib/format";

dayjs.extend(utc);
dayjs.extend(timezone);

// 单号 = 前缀 + yyyyMMdd（北京日期）+ 4 位当日流水。计数器在事务里自增，同一天不会重号。

export type DocPrefix = "PO" | "RI" | "TR" | "ST" | "SO" | "RT" | "RC" | "DC" | "WX" | "YY" | "JS" | "GB" | "KP" | "SP" | "BX";

export function todayBizDateText(): string {
  return dayjs().tz(APP_TIMEZONE).format("YYYYMMDD");
}

/** 给 @db.Date 字段用的"今天"（北京日期） */
export function todayBizDate(): Date {
  return new Date(dayjs().tz(APP_TIMEZONE).format("YYYY-MM-DD"));
}

export async function nextDocNo(tx: Prisma.TransactionClient, prefix: DocPrefix): Promise<string> {
  const date = todayBizDateText();
  const key = `${prefix}${date}`;
  const counter = await tx.docCounter.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1 },
  });
  return `${key}${String(counter.value).padStart(4, "0")}`;
}
