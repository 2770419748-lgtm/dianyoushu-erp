// 国补（口径第 15 节）：算补贴、资格码校验（模拟）、平台结果表格解析。纯函数，页面、服务层、演示数据生成共用，单元测试见 tests/subsidy.test.ts。

export type SubsidyStatusKey = "PENDING" | "SUBMITTED" | "APPROVED" | "SETTLED" | "REJECTED" | "CANCELLED" | "RETURN_DUE" | "RETURNED";

export const SUBSIDY_STATUS_LABELS: Record<SubsidyStatusKey, string> = {
  PENDING: "待提交",
  SUBMITTED: "审核中",
  APPROVED: "待到账",
  SETTLED: "已到账",
  REJECTED: "被驳回",
  CANCELLED: "已撤销",
  RETURN_DUE: "需退回",
  RETURNED: "已退回",
};

export const SUBSIDY_STATUS_COLORS: Record<SubsidyStatusKey, string> = {
  PENDING: "blue",
  SUBMITTED: "processing",
  APPROVED: "cyan",
  SETTLED: "green",
  REJECTED: "red",
  CANCELLED: "default",
  RETURN_DUE: "orange",
  RETURNED: "default",
};

/** 算“每人每类一台”时占名额的状态：撤销、退回的不占（机器退了） */
export const SUBSIDY_USED_STATUSES: SubsidyStatusKey[] = ["PENDING", "SUBMITTED", "APPROVED", "SETTLED", "REJECTED", "RETURN_DUE"];
/** 国补应收：还没到账、没撤销、没被驳回的 */
export const SUBSIDY_RECEIVABLE_STATUSES: SubsidyStatusKey[] = ["PENDING", "SUBMITTED", "APPROVED"];

export interface SubsidyPolicyRule {
  id: number;
  categoryId: number;
  categoryName: string;
  rateBp: number; // 万分之几
  capFen: number;
  priceCapFen: number;
  startsOn: Date;
  endsOn: Date;
  isActive: boolean;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** 这条政策今天能不能用 */
export function policyInEffect(p: Pick<SubsidyPolicyRule, "isActive" | "startsOn" | "endsOn">, today: Date): boolean {
  return p.isActive && p.startsOn.getTime() <= today.getTime() && today.getTime() <= p.endsOn.getTime();
}

/** 一台机器的补贴：成交价 × 比例（四舍五入到分），不超过封顶 */
export function subsidyFenOf(baseFen: number, policy: Pick<SubsidyPolicyRule, "rateBp" | "capFen">): number {
  return Math.min(Math.round((baseFen * policy.rateBp) / 10000), policy.capFen);
}

/** 整单优惠按金额比例分摊到这一行（和退货分摊同一个算法） */
export function lineBaseFen(lineTotalFen: number, subtotalFen: number, totalFen: number): number {
  if (subtotalFen <= 0) return 0;
  return Math.round((lineTotalFen * totalFen) / subtotalFen);
}

export interface SubsidyCandidate {
  key: number; // 调用方自己的行号
  categoryId: number;
  baseFen: number; // 分摊整单优惠后的成交价
}

export interface SubsidyPick {
  key: number;
  policyId: number;
  categoryId: number;
  baseFen: number;
  subsidyFen: number;
}

export interface SubsidyPlan {
  picks: SubsidyPick[];
  notes: string[]; // 为什么有的品类没补，给店员看
}

/**
 * 这单补哪台机器（口径第 15 节）：一个资格码只补一台，在符合条件的机器里挑补贴最多的那台；
 * 符合条件 = 品类有今天在用的政策、成交价不超过上限、这个客户在政策期内这一品类没用过（usedCategoryIds）。
 */
export function planSubsidy(candidates: SubsidyCandidate[], policies: SubsidyPolicyRule[], usedCategoryIds: Set<number>, today: Date): SubsidyPlan {
  const picks: SubsidyPick[] = [];
  const notes: string[] = [];
  const categories = [...new Set(candidates.map((c) => c.categoryId))];
  for (const categoryId of categories) {
    const policy = policies.find((p) => p.categoryId === categoryId && policyInEffect(p, today));
    if (!policy) continue; // 这个品类没有国补（如配件）就不提
    if (usedCategoryIds.has(categoryId)) {
      notes.push(`这位客户 ${ymd(policy.startsOn)} 以来已经用过一次${policy.categoryName}国补，每人每类只能一台`);
      continue;
    }
    const inCategory = candidates.filter((c) => c.categoryId === categoryId);
    // 成交价不超过上限、算出来的补贴大于 0（改价到几分钱的，补贴四舍五入是 0，不能补）
    const eligible = inCategory.filter((c) => c.baseFen <= policy.priceCapFen && subsidyFenOf(c.baseFen, policy) > 0);
    if (eligible.length === 0) {
      const tooHigh = inCategory.some((c) => c.baseFen > policy.priceCapFen);
      notes.push(tooHigh ? `${policy.categoryName}成交价超过 ${(policy.priceCapFen / 100).toFixed(0)} 元，不能补` : `${policy.categoryName}成交价太低，算出来的补贴是 0，不能用国补`);
      continue;
    }
    for (const e of eligible) picks.push({ key: e.key, policyId: policy.id, categoryId, baseFen: e.baseFen, subsidyFen: subsidyFenOf(e.baseFen, policy) });
  }
  if (picks.length <= 1) return { picks, notes };
  const best = [...picks].sort((x, y) => y.subsidyFen - x.subsidyFen || x.key - y.key)[0]!;
  notes.push("一个资格码只补一台，补了补贴最多的那台；另一台要补就分开开单、用另一个资格码");
  return { picks: [best], notes };
}

/** 资格码的格式：平台核销码，字母数字 8～32 位 */
export function normalizeQualificationCode(raw: unknown): string | null {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z0-9]{8,32}$/.test(code) ? code : null;
}

/**
 * 模拟平台核验资格码（演示用）：尾号 0000 的当作资格已过期，其余通过。
 * 真用时顾客在收银台的支付终端上核销，平台给的核销码记进来，系统不再连平台核验。
 */
export function simulateVerifyQualification(code: string): { ok: true } | { ok: false; reason: string } {
  if (code.endsWith("0000")) return { ok: false, reason: "平台核验没通过：这个补贴资格已过期或已经用过（演示：尾号 0000 的码都当作过期）" };
  return { ok: true };
}

// ---------- 平台审核结果表格 ----------

export type PlatformResultKey = "APPROVED" | "REJECTED" | "SETTLED";

export interface PlatformResultLine {
  code: string;
  result: PlatformResultKey;
  amountFen: number;
  reason: string | null;
}

export class SubsidyParseError extends Error {}

const RESULT_BY_LABEL: Record<string, PlatformResultKey> = { 通过: "APPROVED", 审核通过: "APPROVED", 驳回: "REJECTED", 不通过: "REJECTED", 已到账: "SETTLED", 到账: "SETTLED" };

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * 解析平台导出的审核 / 到账结果 CSV：表头要有“核销码”“结果”，可以有“金额（元）”“原因”；列的顺序不限。
 * 结果写“通过”“驳回”“已到账”；已到账没写金额的按国补单的补贴算。
 */
export function parsePlatformResultCsv(text: string): PlatformResultLine[] {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rows.length < 2) throw new SubsidyParseError("表格是空的：第一行表头，下面每行一台");
  const header = splitCsvLine(rows[0]!).map((h) => h.replace(/（元）|\(元\)/g, ""));
  const col = (name: string) => header.indexOf(name);
  const idx = { code: col("核销码"), result: col("结果"), amount: col("金额"), reason: col("原因") };
  if (idx.code < 0 || idx.result < 0) throw new SubsidyParseError("表头要有“核销码”和“结果”");
  return rows.slice(1).map((row, i) => {
    const lineNo = i + 2;
    const cells = splitCsvLine(row);
    const get = (j: number) => (j >= 0 ? (cells[j] ?? "") : "");
    const code = normalizeQualificationCode(get(idx.code));
    if (!code) throw new SubsidyParseError(`第 ${lineNo} 行的核销码“${get(idx.code)}”不对`);
    const result = RESULT_BY_LABEL[get(idx.result)];
    if (!result) throw new SubsidyParseError(`第 ${lineNo} 行的结果“${get(idx.result)}”不认识（写通过、驳回或已到账）`);
    const amountText = get(idx.amount);
    if (amountText && !/^\d+(\.\d{1,2})?$/.test(amountText)) throw new SubsidyParseError(`第 ${lineNo} 行的金额“${amountText}”不对`);
    return { code, result, amountFen: amountText ? Math.round(Number(amountText) * 100) : 0, reason: get(idx.reason) || null };
  });
}

/** 平台结果能不能落到这张国补单上，落上去变什么状态；不能落的返回原因 */
export function applyPlatformResult(status: SubsidyStatusKey, result: PlatformResultKey): { next: SubsidyStatusKey } | { skip: string } {
  if (result === "APPROVED") return status === "SUBMITTED" ? { next: "APPROVED" } : { skip: `${SUBSIDY_STATUS_LABELS[status]}的单不能审核通过` };
  if (result === "REJECTED") return status === "SUBMITTED" || status === "APPROVED" ? { next: "REJECTED" } : { skip: `${SUBSIDY_STATUS_LABELS[status]}的单不能驳回` };
  // 已到账：审核中、待到账的都可以（平台审核和打款同一批出也行）
  return status === "SUBMITTED" || status === "APPROVED" ? { next: "SETTLED" } : { skip: `${SUBSIDY_STATUS_LABELS[status]}的单不能记到账` };
}

/** 生成平台结果 CSV（模拟、导出样例用），和 parsePlatformResultCsv 对得上 */
export function platformResultToCsv(lines: PlatformResultLine[]): string {
  const label: Record<PlatformResultKey, string> = { APPROVED: "通过", REJECTED: "驳回", SETTLED: "已到账" };
  return ["核销码,结果,金额（元）,原因", ...lines.map((l) => [l.code, label[l.result], (l.amountFen / 100).toFixed(2), l.reason ?? ""].join(","))].join("\n");
}
