import { describe, expect, it } from "vitest";
import { isAccidentalDamage, payerOptions, repairChargeFen, warrantyEndsOn } from "@/lib/repair";

// 售后维修谁来付（口径第 13 节）：保修看本店开单日起 12 个月、不保屏幕和进水；碎屏险只管屏幕；延保管非人为故障。
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);
const allowed = (options: ReturnType<typeof payerOptions>) => options.filter((o) => o.allowed).map((o) => o.payer);

describe("售后维修：谁来付", () => {
  it("保修 12 个月，从开单营业日算，到期日算法和服务权益一样", () => {
    expect(ymd(warrantyEndsOn(d("2026-01-15")))).toBe("2027-01-14");
  });

  it("本店卖的、保修期内、电池坏了：能保修；屏幕、进水不能", () => {
    const base = { today: d("2026-10-20"), purchasedOn: d("2026-05-01"), entitlements: [] };
    expect(allowed(payerOptions({ ...base, fault: "BATTERY" }))).toEqual(["CUSTOMER", "WARRANTY"]);
    expect(allowed(payerOptions({ ...base, fault: "SCREEN" }))).toEqual(["CUSTOMER"]);
    const water = payerOptions({ ...base, fault: "WATER" }).find((o) => o.payer === "WARRANTY")!;
    expect(water.reason).toContain("人为损坏");
  });

  it("过了保修期、外面买的机器都不能保修", () => {
    expect(payerOptions({ fault: "BOARD", today: d("2026-10-20"), purchasedOn: d("2025-09-01"), entitlements: [] }).find((o) => o.payer === "WARRANTY")!.reason).toContain("已经过了");
    expect(payerOptions({ fault: "BOARD", today: d("2026-10-20"), purchasedOn: null, entitlements: [] }).find((o) => o.payer === "WARRANTY")!.reason).toContain("厂家");
  });

  it("碎屏险只管屏幕，过期了不能用；延保管非人为故障", () => {
    const ents = [
      { id: 1, kind: "SCREEN_INSURANCE" as const, expiresOn: d("2027-01-01") },
      { id: 2, kind: "EXTENDED_WARRANTY" as const, expiresOn: d("2027-06-01") },
    ];
    const screen = payerOptions({ fault: "SCREEN", today: d("2026-10-20"), purchasedOn: null, entitlements: ents });
    expect(allowed(screen)).toEqual(["CUSTOMER", "SCREEN_INSURANCE"]);
    expect(screen.find((o) => o.payer === "SCREEN_INSURANCE")!.entitlementId).toBe(1);
    const board = payerOptions({ fault: "BOARD", today: d("2026-10-20"), purchasedOn: null, entitlements: ents });
    expect(allowed(board)).toEqual(["CUSTOMER", "EXTENDED_WARRANTY"]);
    expect(board.find((o) => o.payer === "EXTENDED_WARRANTY")!.entitlementId).toBe(2);
    const expired = payerOptions({ fault: "SCREEN", today: d("2027-02-01"), purchasedOn: null, entitlements: ents });
    expect(expired.find((o) => o.payer === "SCREEN_INSURANCE")!.allowed).toBe(false);
  });

  it("客户应付：自费 = 配件费 + 工时费，其他都是 0；屏幕和进水算人为损坏", () => {
    expect(repairChargeFen("CUSTOMER", 80000, 5000)).toBe(85000);
    expect(repairChargeFen("WARRANTY", 80000, 5000)).toBe(0);
    expect(repairChargeFen("SCREEN_INSURANCE", 80000, 5000)).toBe(0);
    expect(isAccidentalDamage("SCREEN")).toBe(true);
    expect(isAccidentalDamage("BATTERY")).toBe(false);
  });
});
