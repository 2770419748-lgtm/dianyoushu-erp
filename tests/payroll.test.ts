import { describe, expect, it } from "vitest";
import { computeSlip, daysInMonthOf, employedDaysOf, rateText } from "@/lib/payroll";

// 工资条怎么算（口径第 19 节）。纯函数，不连库。

const plan = { salesRateBp: 100, perDeviceFen: 2000, perServiceFen: 1500 }; // 1%、每台 20 元、每份 15 元

describe("在职天数", () => {
  it("整月在职；月中入职、月中离职按自然日含当天；不在这个月的是 0", () => {
    expect(daysInMonthOf("2026-10")).toBe(31);
    expect(daysInMonthOf("2028-02")).toBe(29);
    expect(employedDaysOf("2026-10", null, null)).toBe(31);
    expect(employedDaysOf("2026-10", "2025-03-01", null)).toBe(31);
    expect(employedDaysOf("2026-10", "2026-10-16", null)).toBe(16);
    expect(employedDaysOf("2026-10", null, "2026-10-10")).toBe(10);
    expect(employedDaysOf("2026-10", "2026-10-05", "2026-10-06")).toBe(2);
    expect(employedDaysOf("2026-10", "2026-11-01", null)).toBe(0);
    expect(employedDaysOf("2026-10", null, "2026-09-30")).toBe(0);
  });
});

describe("一张工资条", () => {
  it("应发 = 基本工资 + 提成 − 缺勤扣款 + 奖惩；缺勤一天扣 基本工资 ÷ 当月天数", () => {
    const n = computeSlip({ month: "2026-10", baseSalaryFen: 400000, hireDate: null, leaveDate: null, absentDays: 2, salesFen: 12345600, deviceQty: 30, serviceQty: 8, plan, adjustmentFen: -5000 });
    expect(n).toEqual({
      daysInMonth: 31,
      employedDays: 31,
      baseFen: 400000,
      absenceDeductionFen: 25806, // 2 × 4000 ÷ 31 = 258.06 元
      salesCommissionFen: 123456, // 123456 元 × 1%
      deviceCommissionFen: 60000,
      serviceCommissionFen: 12000,
      commissionFen: 195456,
      grossFen: 400000 + 195456 - 25806 - 5000,
    });
  });

  it("月中入职按在职天数折算；缺勤扣款不超过折算后的基本工资；没选方案没有提成", () => {
    const n = computeSlip({ month: "2026-10", baseSalaryFen: 310000, hireDate: "2026-10-22", leaveDate: null, absentDays: 20, salesFen: 500000, deviceQty: 3, serviceQty: 1, plan: null, adjustmentFen: 0 });
    expect(n).toMatchObject({ employedDays: 10, baseFen: 100000, absenceDeductionFen: 100000, commissionFen: 0, grossFen: 0 });
  });

  it("上个月卖的这个月退了：销售额、台数是负的，提成冲回", () => {
    const n = computeSlip({ month: "2026-10", baseSalaryFen: 0, hireDate: null, leaveDate: null, absentDays: 0, salesFen: -299900, deviceQty: -1, serviceQty: 0, plan, adjustmentFen: 0 });
    expect(n).toMatchObject({ salesCommissionFen: -2999, deviceCommissionFen: -2000, commissionFen: -4999, grossFen: -4999 });
  });

  it("比例显示", () => {
    expect(rateText(100)).toBe("1%");
    expect(rateText(25)).toBe("0.25%");
    expect(rateText(150)).toBe("1.5%");
    expect(rateText(0)).toBe("0%");
  });
});
