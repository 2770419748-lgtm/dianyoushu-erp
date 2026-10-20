// 审批（口径第 17 节）：规则怎么判断、名称。纯函数，页面、服务层、演示数据生成共用，单元测试见 tests/approval.test.ts。

export type ApprovalRuleKindKey = "SALE_DISCOUNT" | "SALE_BELOW_COST" | "RETURN_REFUND" | "SALE_VOID" | "TRANSFER" | "STOCKTAKE_LOSS";
export type ApprovalActionKey = "SALE" | "RETURN" | "SALE_VOID" | "TRANSFER" | "STOCKTAKE";
export type ApprovalStatusKey = "PENDING" | "EXECUTED" | "FAILED" | "REJECTED" | "CANCELLED";
export type ApproverRoleKey = "STORE_MANAGER" | "HQ";
export type RequesterRoleKey = "STAFF" | "STORE_MANAGER" | "REGIONAL_MANAGER" | "HQ";

export const APPROVAL_RULE_KINDS: ApprovalRuleKindKey[] = ["SALE_DISCOUNT", "SALE_BELOW_COST", "RETURN_REFUND", "SALE_VOID", "TRANSFER", "STOCKTAKE_LOSS"];

export const APPROVAL_RULE_LABELS: Record<ApprovalRuleKindKey, string> = {
  SALE_DISCOUNT: "开单让利",
  SALE_BELOW_COST: "低于成本卖",
  RETURN_REFUND: "退货退款",
  SALE_VOID: "作废销售单",
  TRANSFER: "调拨",
  STOCKTAKE_LOSS: "盘点盘亏",
};

export const APPROVAL_RULE_HINTS: Record<ApprovalRuleKindKey, string> = {
  SALE_DISCOUNT: "改价加整单优惠，让出去的钱（原价合计 − 应收）达到金额或比例门槛就要批",
  SALE_BELOW_COST: "有机器的成交价低于它的成本就要批（不用填门槛）",
  RETURN_REFUND: "退款金额达到门槛就要批",
  SALE_VOID: "应收达到门槛的单作废要批；门槛填 0 就是作废都要批",
  TRANSFER: "调拨货值（按成本）达到门槛就要批",
  STOCKTAKE_LOSS: "确认盘点时盘亏货值（按成本）达到门槛就要批",
};

/** 每个场景对应审批单要做的事 */
export const RULE_ACTION: Record<ApprovalRuleKindKey, ApprovalActionKey> = {
  SALE_DISCOUNT: "SALE",
  SALE_BELOW_COST: "SALE",
  RETURN_REFUND: "RETURN",
  SALE_VOID: "SALE_VOID",
  TRANSFER: "TRANSFER",
  STOCKTAKE_LOSS: "STOCKTAKE",
};

export const APPROVAL_ACTION_LABELS: Record<ApprovalActionKey, string> = { SALE: "开单", RETURN: "退货", SALE_VOID: "作废销售单", TRANSFER: "调拨", STOCKTAKE: "盘点确认" };
export const APPROVAL_STATUS_LABELS: Record<ApprovalStatusKey, string> = { PENDING: "待审批", EXECUTED: "已通过", FAILED: "批了没做成", REJECTED: "已驳回", CANCELLED: "已撤回" };
export const APPROVAL_STATUS_COLORS: Record<ApprovalStatusKey, string> = { PENDING: "blue", EXECUTED: "green", FAILED: "orange", REJECTED: "red", CANCELLED: "default" };
export const APPROVER_ROLE_LABELS: Record<ApproverRoleKey, string> = { STORE_MANAGER: "店长", HQ: "总部" };

export interface ApprovalRuleConfig {
  kind: ApprovalRuleKindKey;
  enabled: boolean;
  thresholdFen: number | null;
  thresholdBp: number | null;
  approverRole: ApproverRoleKey;
}

/** 每件事拿来判断的数 */
export type ApprovalFacts =
  | { action: "SALE"; listFen: number; totalFen: number; belowCostCount: number }
  | { action: "RETURN"; refundFen: number }
  | { action: "SALE_VOID"; totalFen: number }
  | { action: "TRANSFER"; costFen: number }
  | { action: "STOCKTAKE"; lossCostFen: number };

const RANK: Record<RequesterRoleKey, number> = { STAFF: 1, STORE_MANAGER: 2, REGIONAL_MANAGER: 2, HQ: 3 };
const yuan = (fen: number) => (fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export interface ApprovalDecision {
  required: boolean;
  approverRole: ApproverRoleKey; // 要批的话谁批（取触发的规则里最高的）
  reasons: { kind: ApprovalRuleKindKey; text: string }[];
  amountFen: number; // 关键金额
}

/** 这条规则管不管这件事：返回触发原因，没触发返回 null */
function ruleReason(rule: ApprovalRuleConfig, facts: ApprovalFacts): string | null {
  if (!rule.enabled || RULE_ACTION[rule.kind] !== facts.action) return null;
  const fen = rule.thresholdFen;
  switch (rule.kind) {
    case "SALE_DISCOUNT": {
      if (facts.action !== "SALE") return null;
      const giveaway = facts.listFen - facts.totalFen;
      if (giveaway <= 0) return null;
      const pct = facts.listFen > 0 ? (giveaway * 100) / facts.listFen : 0;
      const byFen = fen !== null && fen > 0 && giveaway >= fen;
      const byPct = rule.thresholdBp !== null && rule.thresholdBp > 0 && giveaway * 10000 >= facts.listFen * rule.thresholdBp;
      if (!byFen && !byPct) return null;
      return `这单让利 ${yuan(giveaway)} 元，占原价 ${pct.toFixed(1)}%，${byFen ? `超过了 ${yuan(fen!)} 元` : `超过了 ${rule.thresholdBp! / 100}%`}`;
    }
    case "SALE_BELOW_COST":
      return facts.action === "SALE" && facts.belowCostCount > 0 ? `有 ${facts.belowCostCount} 台机器的成交价低于成本` : null;
    case "RETURN_REFUND":
      return facts.action === "RETURN" && fen !== null && facts.refundFen >= fen && facts.refundFen > 0 ? `退款 ${yuan(facts.refundFen)} 元，达到了 ${yuan(fen)} 元` : null;
    case "SALE_VOID":
      return facts.action === "SALE_VOID" && facts.totalFen >= (fen ?? 0) ? (fen ? `作废的单应收 ${yuan(facts.totalFen)} 元，达到了 ${yuan(fen)} 元` : "作废销售单都要批") : null;
    case "TRANSFER":
      return facts.action === "TRANSFER" && fen !== null && facts.costFen >= fen && facts.costFen > 0 ? `调拨货值 ${yuan(facts.costFen)} 元（按成本），达到了 ${yuan(fen)} 元` : null;
    case "STOCKTAKE_LOSS":
      return facts.action === "STOCKTAKE" && fen !== null && facts.lossCostFen >= fen && facts.lossCostFen > 0 ? `盘亏货值 ${yuan(facts.lossCostFen)} 元（按成本），达到了 ${yuan(fen)} 元` : null;
  }
}

function keyAmount(facts: ApprovalFacts): number {
  switch (facts.action) {
    case "SALE":
      return Math.max(0, facts.listFen - facts.totalFen);
    case "RETURN":
      return facts.refundFen;
    case "SALE_VOID":
      return facts.totalFen;
    case "TRANSFER":
      return facts.costFen;
    case "STOCKTAKE":
      return facts.lossCostFen;
  }
}

/**
 * 要不要审批（口径第 17 节）：看所有打开的、管这件事的规则；发起人角色够得上审批人的那条不算
 * （店长自己做、规则写店长批，不用批；总部做的都不用批）。几条都触发就合成一张，审批人取最高的。
 */
export function decideApproval(rules: ApprovalRuleConfig[], facts: ApprovalFacts, requesterRole: RequesterRoleKey): ApprovalDecision {
  const reasons: ApprovalDecision["reasons"] = [];
  let approverRole: ApproverRoleKey = "STORE_MANAGER";
  for (const rule of rules) {
    const reason = ruleReason(rule, facts);
    if (!reason) continue;
    if (RANK[requesterRole] >= RANK[rule.approverRole]) continue;
    reasons.push({ kind: rule.kind, text: reason });
    if (rule.approverRole === "HQ") approverRole = "HQ";
  }
  return { required: reasons.length > 0, approverRole, reasons, amountFen: keyAmount(facts) };
}

/** 这个人能不能批这张单（门店范围另外查）：店长批的店长和总部都能批，总部批的只有总部；不能批自己发起的 */
export function canDecide(approverRole: ApproverRoleKey, deciderRole: RequesterRoleKey, isRequester: boolean): boolean {
  if (isRequester) return false;
  if (deciderRole === "HQ") return true;
  return approverRole === "STORE_MANAGER" && deciderRole === "STORE_MANAGER";
}
