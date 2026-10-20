// 服务权益的日期规则（口径第 12 节）。纯函数，页面和服务层共用，单元测试见 tests/entitlement.test.ts。
// 日期一律是 @db.Date 那种“UTC 零点表示的北京日期”（和销售单的营业日一样），只按年月日算，不碰时分秒。

const DAY_MS = 24 * 60 * 60 * 1000;

/** 到期提醒分两档：剩 8～30 天一档、剩 0～7 天一档；按区间筛，漏跑一天也不会错过 */
export const REMINDER_T30_MAX_DAYS = 30;
export const REMINDER_T7_MAX_DAYS = 7;

export type ReminderStageKey = "T30" | "T7";

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

/** 加 N 个月；目标月没有这一天（如 1 月 31 日加 1 个月）就取目标月的最后一天 */
export function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return utcDate(year, monthIndex, Math.min(date.getUTCDate(), lastDay));
}

/**
 * 到期日 = 生效日 + N 个月 − 1 天，到期日当天 24:00 失效。
 * 例：2026-01-15 起 12 个月 → 2027-01-14；2026-01-31 起 1 个月 → 2 月 28 日再减一天 = 2026-02-27。
 */
export function entitlementExpiresOn(startedOn: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 1) throw new Error("服务期限必须是正整数个月");
  return new Date(addMonthsClamped(startedOn, months).getTime() - DAY_MS);
}

/** 离到期还有几天：到期当天是 0，已经过期是负数 */
export function daysUntil(expiresOn: Date, today: Date): number {
  return Math.round((expiresOn.getTime() - today.getTime()) / DAY_MS);
}

/** 剩余天数落在哪一档提醒；不在 0～30 天里返回 null */
export function reminderStageFor(daysLeft: number): ReminderStageKey | null {
  if (daysLeft < 0 || daysLeft > REMINDER_T30_MAX_DAYS) return null;
  return daysLeft <= REMINDER_T7_MAX_DAYS ? "T7" : "T30";
}

/** 页面上显示的权益状态 */
export function entitlementStateLabel(status: "ACTIVE" | "VOIDED" | "CLAIMED", daysLeft: number): string {
  if (status === "VOIDED") return "已失效";
  if (status === "CLAIMED") return "已理赔"; // 碎屏险在维修单上用掉了（口径第 13 节）
  if (daysLeft < 0) return "已过期";
  if (daysLeft <= REMINDER_T30_MAX_DAYS) return "即将到期";
  return "保障中";
}

export const REMINDER_STAGE_LABELS: Record<ReminderStageKey, string> = {
  T30: "剩 8～30 天",
  T7: "剩 0～7 天",
};

/** 某一档的到期日区间（含两端）：today + min 天 到 today + max 天 */
export function stageDateRange(stage: ReminderStageKey, today: Date): { from: Date; to: Date } {
  const [min, max] = stage === "T7" ? [0, REMINDER_T7_MAX_DAYS] : [REMINDER_T7_MAX_DAYS + 1, REMINDER_T30_MAX_DAYS];
  return { from: new Date(today.getTime() + min * DAY_MS), to: new Date(today.getTime() + max * DAY_MS) };
}
