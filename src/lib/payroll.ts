// 提成和工资条（口径第 19 节）：在职天数、折算基本工资、缺勤扣款、提成、应发怎么算。纯函数，服务层、页面、单元测试共用（tests/payroll.test.ts）。
// 应发 = 基本工资（入职、离职当月按在职天数折算）+ 提成 − 缺勤扣款（缺勤一天扣 基本工资 ÷ 当月天数）+ 其他奖惩。社保、个税财务另算，这里只到应发。

export type PayrollStatusKey = "DRAFT" | "PUBLISHED" | "VOIDED";
export const PAYROLL_STATUS_LABELS: Record<PayrollStatusKey, string> = { DRAFT: "草稿", PUBLISHED: "已发布", VOIDED: "已作废" };
export const PAYROLL_STATUS_COLORS: Record<PayrollStatusKey, string> = { DRAFT: "blue", PUBLISHED: "green", VOIDED: "default" };

/** 一个月有几天（"2026-10" → 31） */
export function daysInMonthOf(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * 这个月在职几天（自然日）：从入职日（没填当月 1 号）到离职日（没填当月最后一天），都含当天；
 * 入职在这个月以后、离职在这个月以前的是 0。
 */
export function employedDaysOf(month: string, hireDate: string | null, leaveDate: string | null): number {
  const total = daysInMonthOf(month);
  const first = `${month}-01`;
  const last = `${month}-${String(total).padStart(2, "0")}`;
  const from = hireDate && hireDate > first ? hireDate : first;
  const to = leaveDate && leaveDate < last ? leaveDate : last;
  if (from > to) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

export interface PlanRates {
  salesRateBp: number; // 销售额提成：万分之几
  perDeviceFen: number;
  perServiceFen: number;
}

export interface SlipInput {
  month: string;
  baseSalaryFen: number;
  hireDate: string | null;
  leaveDate: string | null;
  absentDays: number;
  salesFen: number; // 销售额（扣掉退货，可能是负的：上个月卖的这个月退了）
  deviceQty: number;
  serviceQty: number;
  plan: PlanRates | null;
  adjustmentFen: number;
}

export interface SlipNumbers {
  daysInMonth: number;
  employedDays: number;
  baseFen: number;
  absenceDeductionFen: number;
  salesCommissionFen: number;
  deviceCommissionFen: number;
  serviceCommissionFen: number;
  commissionFen: number;
  grossFen: number;
}

/**
 * 算一张工资条的数：
 * - 折算后基本工资 = 基本工资 × 在职天数 ÷ 当月天数（四舍五入到分）；
 * - 缺勤扣款 = 缺勤天数 × 基本工资 ÷ 当月天数，最多扣到折算后基本工资为止（不倒扣）；
 * - 提成 = 销售额 × 比例 + 台数 × 每台 + 份数 × 每份；退货多过卖的会是负数（上个月卖的这个月退了，提成冲回）；没选方案没有提成；
 * - 应发 = 折算后基本工资 + 提成 − 缺勤扣款 + 奖惩。
 */
export function computeSlip(input: SlipInput): SlipNumbers {
  const daysInMonth = daysInMonthOf(input.month);
  const employedDays = employedDaysOf(input.month, input.hireDate, input.leaveDate);
  const baseFen = Math.round((input.baseSalaryFen * employedDays) / daysInMonth);
  const absenceDeductionFen = Math.min(baseFen, Math.round((input.absentDays * input.baseSalaryFen) / daysInMonth));
  const plan = input.plan;
  const salesCommissionFen = plan ? Math.round((input.salesFen * plan.salesRateBp) / 10000) : 0;
  const deviceCommissionFen = plan ? input.deviceQty * plan.perDeviceFen : 0;
  const serviceCommissionFen = plan ? input.serviceQty * plan.perServiceFen : 0;
  const commissionFen = salesCommissionFen + deviceCommissionFen + serviceCommissionFen;
  return {
    daysInMonth,
    employedDays,
    baseFen,
    absenceDeductionFen,
    salesCommissionFen,
    deviceCommissionFen,
    serviceCommissionFen,
    commissionFen,
    grossFen: baseFen + commissionFen - absenceDeductionFen + input.adjustmentFen,
  };
}

/** 比例显示：100 → "1%"，25 → "0.25%" */
export function rateText(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
