import "server-only";
import { APPROVER_ROLE_LABELS, decideApproval, type ApprovalActionKey, type ApprovalDecision, type ApprovalFacts, type ApprovalRuleConfig } from "@/lib/approval";
import type { CurrentUser } from "@/server/auth/current-user";
import type { Db } from "@/server/db-tx";

// 审批检查（口径第 17 节）：开单、退货、作废、调拨、盘点确认这几处服务层在真正动数据之前调一下。
// 触发了规则就抛 ApprovalRequiredError，这件事不做；Server Function 接住它，存一张审批单。批下来时带 approved: true 再调一次服务层。
// 单独放一个文件，只依赖纯函数：服务层引用它，审批服务再引用服务层，不会循环引用。

export class ApprovalRequiredError extends Error {
  constructor(
    readonly decision: ApprovalDecision,
    readonly context: { action: ApprovalActionKey; storeId: number; summary: string; details: string[]; dedupeKey: string | null; frozenInput?: unknown },
  ) {
    super(`要${APPROVER_ROLE_LABELS[decision.approverRole]}审批：${decision.reasons.map((r) => r.text).join("；")}`);
  }
}

/** 打开的审批规则（没配过的场景没有行，等于关着） */
export async function loadApprovalRules(db: Db): Promise<ApprovalRuleConfig[]> {
  const rows = await db.approvalRule.findMany({ where: { enabled: true } });
  return rows.map((r) => ({ kind: r.kind, enabled: r.enabled, thresholdFen: r.thresholdFen, thresholdBp: r.thresholdBp, approverRole: r.approverRole === "HQ" ? "HQ" : "STORE_MANAGER" }));
}

export interface ApprovalCheckOptions {
  approved?: boolean; // 审批通过后执行时传 true，不再检查
}

/** 要审批就抛 ApprovalRequiredError；不用审批（规则没开、没达到门槛、发起人够得上审批人、已经批过）就什么都不做 */
export async function checkApproval(
  db: Db,
  user: CurrentUser,
  facts: ApprovalFacts,
  context: { storeId: number; summary: string; details?: string[]; dedupeKey?: string | null; frozenInput?: unknown },
  options: ApprovalCheckOptions = {},
) {
  if (options.approved) return;
  const rules = await loadApprovalRules(db);
  if (rules.length === 0) return;
  const decision = decideApproval(rules, facts, user.role);
  if (!decision.required) return;
  throw new ApprovalRequiredError(decision, { action: facts.action, storeId: context.storeId, summary: context.summary, details: context.details ?? [], dedupeKey: context.dedupeKey ?? null, frozenInput: context.frozenInput });
}
