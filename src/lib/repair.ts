// 售后维修的规则（口径第 13 节）：状态名、故障类型、保修期、谁能付。纯函数，页面和服务层共用，单元测试见 tests/repair.test.ts。
import { daysUntil, entitlementExpiresOn } from "./entitlement";

export type RepairStatusKey = "RECEIVED" | "QUOTED" | "REPAIRING" | "READY" | "CLOSED" | "VOIDED";
export type RepairPayerKey = "CUSTOMER" | "WARRANTY" | "SCREEN_INSURANCE" | "EXTENDED_WARRANTY";
export type FaultCategoryKey = "SCREEN" | "BATTERY" | "BOARD" | "CAMERA" | "WATER" | "SOFTWARE" | "OTHER";
export type ServiceKindKey = "SCREEN_INSURANCE" | "EXTENDED_WARRANTY" | "OTHER";

export const REPAIR_STATUS_LABELS: Record<RepairStatusKey, string> = {
  RECEIVED: "已接件",
  QUOTED: "已报价",
  REPAIRING: "维修中",
  READY: "待取机",
  CLOSED: "已完结",
  VOIDED: "已作废",
};

export const REPAIR_STATUS_COLORS: Record<RepairStatusKey, string> = {
  RECEIVED: "blue",
  QUOTED: "gold",
  REPAIRING: "processing",
  READY: "orange",
  CLOSED: "green",
  VOIDED: "default",
};

export const REPAIR_PAYER_LABELS: Record<RepairPayerKey, string> = {
  CUSTOMER: "客户自费",
  WARRANTY: "保修",
  SCREEN_INSURANCE: "碎屏险理赔",
  EXTENDED_WARRANTY: "延保",
};

export const FAULT_LABELS: Record<FaultCategoryKey, string> = {
  SCREEN: "屏幕",
  BATTERY: "电池",
  BOARD: "主板",
  CAMERA: "摄像头",
  WATER: "进水",
  SOFTWARE: "软件",
  OTHER: "其他",
};

export const SERVICE_KIND_LABELS: Record<ServiceKindKey, string> = {
  SCREEN_INSURANCE: "碎屏险",
  EXTENDED_WARRANTY: "延保",
  OTHER: "其他",
};

/** 本店卖出的机器保修 12 个月（官方保修一年），从开单营业日算，到期日算法和服务权益一样 */
export const WARRANTY_MONTHS = 12;

export function warrantyEndsOn(purchasedOn: Date): Date {
  return entitlementExpiresOn(purchasedOn, WARRANTY_MONTHS);
}

/** 屏幕碎、进水算人为损坏：保修和延保都不管，屏幕找碎屏险 */
export function isAccidentalDamage(fault: FaultCategoryKey): boolean {
  return fault === "SCREEN" || fault === "WATER";
}

export interface CoverageInput {
  fault: FaultCategoryKey;
  today: Date;
  purchasedOn: Date | null; // 本店卖出的机器才有
  entitlements: { id: number; kind: ServiceKindKey; expiresOn: Date }[]; // 客户生效中、保这台机器的服务
}

export interface PayerOption {
  payer: RepairPayerKey;
  allowed: boolean;
  reason: string; // 能选时说明依据，不能选时说明为什么
  entitlementId?: number;
}

/** 这张维修单能选谁来付（口径第 13 节）；客户自费总能选 */
export function payerOptions(input: CoverageInput): PayerOption[] {
  const accidental = isAccidentalDamage(input.fault);
  const warrantyEnd = input.purchasedOn ? warrantyEndsOn(input.purchasedOn) : null;
  const inWarranty = warrantyEnd !== null && daysUntil(warrantyEnd, input.today) >= 0;
  const valid = input.entitlements.filter((e) => daysUntil(e.expiresOn, input.today) >= 0);
  const screen = valid.find((e) => e.kind === "SCREEN_INSURANCE");
  const extended = valid.find((e) => e.kind === "EXTENDED_WARRANTY");
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  const warranty: PayerOption = !input.purchasedOn
    ? { payer: "WARRANTY", allowed: false, reason: "不是本店卖出的机器，保修找厂家" }
    : !inWarranty
      ? { payer: "WARRANTY", allowed: false, reason: `保修到 ${ymd(warrantyEnd!)} 已经过了` }
      : accidental
        ? { payer: "WARRANTY", allowed: false, reason: "屏幕、进水算人为损坏，不保修" }
        : { payer: "WARRANTY", allowed: true, reason: `本店卖出，保修到 ${ymd(warrantyEnd!)}` };

  const screenOption: PayerOption = !screen
    ? { payer: "SCREEN_INSURANCE", allowed: false, reason: "没有生效中的碎屏险" }
    : input.fault !== "SCREEN"
      ? { payer: "SCREEN_INSURANCE", allowed: false, reason: "碎屏险只管屏幕故障" }
      : { payer: "SCREEN_INSURANCE", allowed: true, reason: `碎屏险到 ${ymd(screen.expiresOn)}，理赔后用掉`, entitlementId: screen.id };

  const extendedOption: PayerOption = !extended
    ? { payer: "EXTENDED_WARRANTY", allowed: false, reason: "没有生效中的延保" }
    : accidental
      ? { payer: "EXTENDED_WARRANTY", allowed: false, reason: "屏幕、进水算人为损坏，延保不管" }
      : { payer: "EXTENDED_WARRANTY", allowed: true, reason: `延保到 ${ymd(extended.expiresOn)}，期内不限次数`, entitlementId: extended.id };

  return [{ payer: "CUSTOMER", allowed: true, reason: "配件费 + 工时费" }, warranty, screenOption, extendedOption];
}

/** 客户应付：自费 = 配件费 + 工时费；保修、碎屏险、延保 = 0 */
export function repairChargeFen(payer: RepairPayerKey, partsFen: number, laborFen: number): number {
  return payer === "CUSTOMER" ? partsFen + laborFen : 0;
}
