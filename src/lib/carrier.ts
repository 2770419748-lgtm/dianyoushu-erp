// 运营商业务（口径第 14 节）：名称、结算单 CSV 解析、按月对账。纯函数，页面、服务层、演示数据生成共用，单元测试见 tests/carrier.test.ts。

export type CarrierKey = "CMCC" | "CUCC" | "CTCC" | "CBN";
export type CarrierBizTypeKey = "NEW_LINE" | "PORT_IN" | "CONTRACT_PHONE" | "BROADBAND" | "PLAN_UPGRADE";
export type CarrierBizStatusKey = "SUBMITTED" | "ACTIVATED" | "FAILED" | "SETTLED" | "CLAWED_BACK" | "VOIDED";
export type CarrierLineResultKey = "MATCHED" | "DIFF" | "UNMATCHED";

export const CARRIERS: CarrierKey[] = ["CMCC", "CUCC", "CTCC", "CBN"];
export const CARRIER_BIZ_TYPES: CarrierBizTypeKey[] = ["NEW_LINE", "PORT_IN", "CONTRACT_PHONE", "BROADBAND", "PLAN_UPGRADE"];

export const CARRIER_LABELS: Record<CarrierKey, string> = { CMCC: "中国移动", CUCC: "中国联通", CTCC: "中国电信", CBN: "中国广电" };

export const CARRIER_BIZ_TYPE_LABELS: Record<CarrierBizTypeKey, string> = {
  NEW_LINE: "新号入网",
  PORT_IN: "携号转入",
  CONTRACT_PHONE: "合约机",
  BROADBAND: "宽带",
  PLAN_UPGRADE: "套餐升级",
};

export const CARRIER_BIZ_STATUS_LABELS: Record<CarrierBizStatusKey, string> = {
  SUBMITTED: "已登记",
  ACTIVATED: "已开通",
  FAILED: "办理失败",
  SETTLED: "已结算",
  CLAWED_BACK: "已返销",
  VOIDED: "已作废",
};

export const CARRIER_BIZ_STATUS_COLORS: Record<CarrierBizStatusKey, string> = {
  SUBMITTED: "blue",
  ACTIVATED: "cyan",
  FAILED: "red",
  SETTLED: "green",
  CLAWED_BACK: "orange",
  VOIDED: "default",
};

/** 结算月份：YYYY-MM；运营商月底后才出结算单，所以只能对已经过完的月份 */
export function isSettleableMonth(month: string, today: Date): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
  const current = today.toISOString().slice(0, 7);
  return month < current;
}

/** 某个月的第一天和下个月第一天（@db.Date 那种 UTC 零点日期） */
export function monthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

// ---------- 结算单 CSV ----------

export interface StatementLine {
  carrierOrderNo: string | null;
  phone: string | null;
  bizType: CarrierBizTypeKey | null;
  commissionFen: number;
  clawbackFen: number;
}

export class StatementParseError extends Error {}

/** 一行 CSV 拆成字段：支持双引号包起来的字段和里面的 "" 转义 */
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

/** 一行佣金、返销最多 10 万元（远超任何号卡、宽带佣金；也防止超出数据库整数范围） */
export const MAX_STATEMENT_LINE_FEN = 10_000_000;

function yuanToFenStrict(text: string, lineNo: number, label: string): number {
  if (!text) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new StatementParseError(`第 ${lineNo} 行的${label}“${text}”不是金额`);
  const fen = Math.round(Number(text) * 100);
  if (fen > MAX_STATEMENT_LINE_FEN) throw new StatementParseError(`第 ${lineNo} 行的${label}“${text}”太大了，一行最多 ${MAX_STATEMENT_LINE_FEN / 100} 元`);
  return fen;
}

const HEADERS = { orderNo: "受理单号", phone: "办理号码", bizType: "业务类型", commission: "佣金", clawback: "返销" } as const;

/**
 * 解析运营商渠道系统导出的结算单 CSV。第一行是表头，要有：受理单号、办理号码、业务类型、佣金（元）、返销（元）（列的顺序不限，表头可以带“（元）”）。
 * 受理单号和办理号码至少有一个；金额是元，最多两位小数。
 */
export function parseStatementCsv(text: string): StatementLine[] {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rows.length < 2) throw new StatementParseError("结算单是空的：第一行表头，下面每行一笔");
  const header = splitCsvLine(rows[0]!).map((h) => h.replace(/（元）|\(元\)/g, ""));
  const col = (name: string) => header.indexOf(name);
  const idx = { orderNo: col(HEADERS.orderNo), phone: col(HEADERS.phone), bizType: col(HEADERS.bizType), commission: col(HEADERS.commission), clawback: col(HEADERS.clawback) };
  if (idx.commission < 0 || (idx.orderNo < 0 && idx.phone < 0)) throw new StatementParseError("表头要有“佣金”，以及“受理单号”或“办理号码”");
  const typeByLabel = new Map(Object.entries(CARRIER_BIZ_TYPE_LABELS).map(([k, v]) => [v, k as CarrierBizTypeKey]));
  return rows.slice(1).map((row, i) => {
    const lineNo = i + 2;
    const cells = splitCsvLine(row);
    const get = (j: number) => (j >= 0 ? (cells[j] ?? "") : "");
    const carrierOrderNo = get(idx.orderNo) || null;
    const phone = get(idx.phone) || null;
    if (!carrierOrderNo && !phone) throw new StatementParseError(`第 ${lineNo} 行没有受理单号也没有号码`);
    const typeText = get(idx.bizType);
    const bizType = typeText ? (typeByLabel.get(typeText) ?? null) : null;
    if (typeText && !bizType) throw new StatementParseError(`第 ${lineNo} 行的业务类型“${typeText}”不认识（新号入网、携号转入、合约机、宽带、套餐升级）`);
    const commissionFen = yuanToFenStrict(get(idx.commission), lineNo, "佣金");
    const clawbackFen = yuanToFenStrict(get(idx.clawback), lineNo, "返销");
    if (commissionFen > 0 && clawbackFen > 0) throw new StatementParseError(`第 ${lineNo} 行佣金和返销都有，一行只能是一种，拆成两行`);
    return { carrierOrderNo, phone, bizType, commissionFen, clawbackFen };
  });
}

/** 生成结算单 CSV（模拟结算单、导出样例用），和 parseStatementCsv 对得上 */
export function statementToCsv(lines: StatementLine[]): string {
  const yuan = (fen: number) => (fen / 100).toFixed(2);
  return [
    "受理单号,办理号码,业务类型,佣金（元）,返销（元）",
    ...lines.map((l) => [l.carrierOrderNo ?? "", l.phone ?? "", l.bizType ? CARRIER_BIZ_TYPE_LABELS[l.bizType] : "", yuan(l.commissionFen), yuan(l.clawbackFen)].join(",")),
  ].join("\n");
}

// ---------- 对账 ----------

export interface ReconcileCandidate {
  id: number;
  carrierOrderNo: string | null;
  phone: string;
  bizType: CarrierBizTypeKey;
  expectedCommissionFen: number;
  status: CarrierBizStatusKey;
  inMonth: boolean; // 登记营业日在这个结算月份里
}

export interface ReconciledLine extends StatementLine {
  businessId: number | null;
  result: CarrierLineResultKey;
}

export interface ReconcileResult {
  lines: ReconciledLine[];
  settle: { id: number; settledFen: number }[]; // 变已结算
  clawback: { id: number; clawbackFen: number }[]; // 变已返销
  missing: number[]; // 这个月已开通、结算单里没给佣金的
}

/**
 * 按月对账（口径第 14 节）：先按受理单号对，没有的按“号码 + 业务类型”对，一笔业务只对一行。
 * 给佣金的行对“已开通”的业务（变已结算）；返销的行对“已开通 / 已结算”的业务（变已返销，可以是以前月份的）。
 */
export function reconcileStatement(lines: StatementLine[], candidates: ReconcileCandidate[]): ReconcileResult {
  const used = new Set<number>();
  const byOrderNo = new Map<string, ReconcileCandidate>();
  const byPhone = new Map<string, ReconcileCandidate[]>();
  for (const c of candidates) {
    if (c.carrierOrderNo) byOrderNo.set(c.carrierOrderNo, c);
    const key = c.phone;
    byPhone.set(key, [...(byPhone.get(key) ?? []), c]);
  }
  const eligible = (c: ReconcileCandidate, line: StatementLine) =>
    !used.has(c.id) && (line.clawbackFen > 0 ? c.status === "ACTIVATED" || c.status === "SETTLED" : c.status === "ACTIVATED") && (!line.bizType || line.bizType === c.bizType);

  const result: ReconcileResult = { lines: [], settle: [], clawback: [], missing: [] };
  for (const line of lines) {
    let match: ReconcileCandidate | undefined;
    if (line.carrierOrderNo) {
      const c = byOrderNo.get(line.carrierOrderNo);
      if (c && eligible(c, line)) match = c;
    }
    if (!match && line.phone) {
      const list = (byPhone.get(line.phone) ?? []).filter((c) => eligible(c, line));
      // 给佣金的优先对这个月的
      match = list.find((c) => c.inMonth) ?? list[0];
    }
    if (!match) {
      result.lines.push({ ...line, businessId: null, result: "UNMATCHED" });
      continue;
    }
    used.add(match.id);
    if (line.clawbackFen > 0) {
      result.clawback.push({ id: match.id, clawbackFen: line.clawbackFen });
      result.lines.push({ ...line, businessId: match.id, result: "MATCHED" });
    } else {
      result.settle.push({ id: match.id, settledFen: line.commissionFen });
      result.lines.push({ ...line, businessId: match.id, result: line.commissionFen === match.expectedCommissionFen ? "MATCHED" : "DIFF" });
    }
  }
  result.missing = candidates.filter((c) => c.inMonth && c.status === "ACTIVATED" && !used.has(c.id)).map((c) => c.id);
  return result;
}
