// 试用和到期（口径第 21 节）：开户信息（套餐、到期日、门店数上限）+ 今天 → 现在处在哪个阶段。纯函数，页面、服务层、测试共用。
// 日期都按北京时间的 YYYY-MM-DD 字符串比；到期日当天还能用，过了那天才算到期。

export type LicensePlan = "TRIAL" | "PAID";
export const LICENSE_PLAN_LABELS: Record<LicensePlan, string> = { TRIAL: "试用", PAID: "正式" };

export interface License {
  plan: LicensePlan;
  startedOn: string; // 开户（或改套餐）那天
  expiresOn: string; // 到期日，当天还能用
  storeLimit: number | null; // 在用门店数上限；空 = 不限（试用）
}

export const WARN_DAYS = 7; // 到期前几天开始提醒
export const GRACE_DAYS = 15; // 到期后照常用几天
export const TRIAL_DAYS = 30; // 默认试用天数

export type LicenseState =
  | { kind: "demo" } // 演示模式，不管到期
  | { kind: "missing" } // 真用却没开户信息：按只读算
  | { kind: "ok"; license: License; daysLeft: number }
  | { kind: "expiring"; license: License; daysLeft: number } // 到期前 WARN_DAYS 天内
  | { kind: "grace"; license: License; daysOver: number; graceLeft: number } // 到期后 GRACE_DAYS 天内，照常用
  | { kind: "readonly"; license: License; daysOver: number }; // 过了宽限期：只读

const DAY_MS = 86400000;

/** 两个 YYYY-MM-DD 之间差几天（b − a） */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** 某个日期加几天 */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function licenseState(license: License | null, today: string, demo: boolean): LicenseState {
  if (demo) return { kind: "demo" };
  if (!license) return { kind: "missing" };
  const daysLeft = daysBetween(today, license.expiresOn);
  if (daysLeft >= 0) return daysLeft <= WARN_DAYS ? { kind: "expiring", license, daysLeft } : { kind: "ok", license, daysLeft };
  const daysOver = -daysLeft;
  if (daysOver <= GRACE_DAYS) return { kind: "grace", license, daysOver, graceLeft: GRACE_DAYS - daysOver };
  return { kind: "readonly", license, daysOver };
}

/** 还能不能改数据 */
export function isWritable(state: LicenseState): boolean {
  return state.kind !== "readonly" && state.kind !== "missing";
}

/** 页面顶上的提醒：level 决定颜色，null 表示不用提醒 */
export function licenseNotice(state: LicenseState): { level: "info" | "warning" | "error"; text: string } | null {
  switch (state.kind) {
    case "expiring":
      return { level: "warning", text: state.daysLeft === 0 ? `${LICENSE_PLAN_LABELS[state.license.plan]}今天到期，明天起进入 ${GRACE_DAYS} 天宽限期，记得续费` : `${LICENSE_PLAN_LABELS[state.license.plan]}还有 ${state.daysLeft} 天到期（${state.license.expiresOn}），记得续费` };
    case "grace":
      return { level: "error", text: `已到期 ${state.daysOver} 天，${state.graceLeft === 0 ? "明天起" : `再过 ${state.graceLeft} 天`}只能查看和导出，不能再开单和改数据。续费请联系给你开户的服务商` };
    case "readonly":
      return { level: "error", text: "服务已到期，现在只能查看和导出，不能开单和改数据。续费请联系给你开户的服务商，续费后马上恢复" };
    case "missing":
      return { level: "error", text: "还没有开户信息，现在只能查看。请联系服务商补上开户信息" };
    default:
      return null;
  }
}
