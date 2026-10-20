// AI 智能提醒（口径第 18 节）：规则的名字和门槛、调拨建议、模板版“今日待办”、按字节截断。纯函数，服务层、页面、单元测试共用。

export type AlertKindKey =
  | "STALE_DEVICES"
  | "LOW_ACCESSORY"
  | "KPI_BEHIND"
  | "DAILY_CLOSE"
  | "TRANSFER_PENDING"
  | "STOCKTAKE_OPEN"
  | "TRADE_IN_IDLE"
  | "APPROVAL_PENDING"
  | "TRANSFER_SUGGEST"
  | "INTEGRITY";

export type AlertScopeKey = "STORE" | "REGION" | "HQ";

export const ALERT_KIND_LABELS: Record<AlertKindKey, string> = {
  STALE_DEVICES: "滞销机器",
  LOW_ACCESSORY: "配件缺货",
  KPI_BEHIND: "KPI 落后",
  DAILY_CLOSE: "日结没做完",
  TRANSFER_PENDING: "调拨没收货",
  STOCKTAKE_OPEN: "盘点没确认",
  TRADE_IN_IDLE: "回收机没处理",
  APPROVAL_PENDING: "待审批",
  TRANSFER_SUGGEST: "调拨建议",
  INTEGRITY: "对账自检",
};

/** 门槛（口径第 18 节的默认值） */
export const ALERT_THRESHOLDS = {
  staleDays: 30,
  kpiBehindPoints: 5, // 完成率比时间进度低几个百分点算落后
  transferDays: 3,
  stocktakeDays: 2,
  tradeInDays: 7,
  suggestMinSold30: 3, // 调拨建议：B 店这个型号近 30 天至少卖了几台
};

/** 一条命中的提醒：程序算好的数字放 facts，detail 是程序写的一句话（模板版直接用它） */
export interface AlertDraft {
  kind: AlertKindKey;
  scope: AlertScopeKey;
  storeId: number | null;
  regionId: number | null;
  severity: 1 | 2 | 3; // 1 一般、2 要紧、3 很急
  title: string;
  detail: string;
  link: string | null;
  facts: Record<string, string | number>;
}

export function scopeKeyOf(draft: Pick<AlertDraft, "scope" | "storeId" | "regionId">): string {
  return draft.scope === "STORE" ? `store:${draft.storeId}` : draft.scope === "REGION" ? `region:${draft.regionId}` : "hq";
}

/** KPI 落后：完成率比时间进度低 5 个百分点以上（没目标的不算） */
export function kpiBehind(rate: number | null, progress: number): boolean {
  return rate !== null && (progress - rate) * 100 >= ALERT_THRESHOLDS.kpiBehindPoints;
}

/** 元，整数带千分位（提醒里说“约 3,200 元”，不写分） */
export function yuanText(fen: number): string {
  return Math.round(fen / 100).toLocaleString("zh-CN");
}

export interface SuggestInput {
  /** 门店 × 型号：在库台数、其中压了 30 天以上的台数、近 30 天卖了几台 */
  rows: { storeId: number; storeName: string; regionId: number; model: string; inStock: number; stale: number; sold30: number }[];
}

export interface TransferSuggestion {
  regionId: number;
  model: string;
  from: { storeId: number; storeName: string; stale: number };
  to: { storeId: number; storeName: string; sold30: number };
}

/**
 * 调拨建议（口径第 18 节）：同一个区域里，A 店这个型号有压了 30 天以上的机器，B 店这个型号近 30 天卖了 3 台以上、现在没货。
 * 每个型号只建议一对：压得最多的店 → 卖得最快的店。按压的台数排，最多给 5 条。
 */
export function suggestTransfers(input: SuggestInput): TransferSuggestion[] {
  const byKey = new Map<string, SuggestInput["rows"]>();
  for (const r of input.rows) byKey.set(`${r.regionId}|${r.model}`, [...(byKey.get(`${r.regionId}|${r.model}`) ?? []), r]);
  const out: TransferSuggestion[] = [];
  for (const rows of byKey.values()) {
    const from = rows.filter((r) => r.stale > 0).sort((a, b) => b.stale - a.stale || a.storeId - b.storeId)[0];
    const to = rows.filter((r) => r.inStock === 0 && r.sold30 >= ALERT_THRESHOLDS.suggestMinSold30).sort((a, b) => b.sold30 - a.sold30 || a.storeId - b.storeId)[0];
    if (from && to && from.storeId !== to.storeId) out.push({ regionId: from.regionId, model: from.model, from: { storeId: from.storeId, storeName: from.storeName, stale: from.stale }, to: { storeId: to.storeId, storeName: to.storeName, sold30: to.sold30 } });
  }
  return out.sort((a, b) => b.from.stale - a.from.stale || a.model.localeCompare(b.model)).slice(0, 5);
}

/** 模板版今日待办：按轻重排，一条一行，带链接说明 */
export function renderTemplateDigest(title: string, items: Pick<AlertDraft, "severity" | "title" | "detail">[]): string {
  const sorted = [...items].sort((a, b) => b.severity - a.severity);
  const lines = sorted.map((item, i) => `${i + 1}. **${item.title}**：${item.detail}`);
  return `### ${title}\n${lines.join("\n")}\n\n> 系统按规则生成`;
}

/** 企业微信群机器人的 markdown 最多 4096 字节：超了按字节截断，末尾说明 */
export function truncateUtf8(text: string, maxBytes = 4096): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  const tail = "\n…（太长了，完整内容在系统的智能提醒页）";
  const budget = maxBytes - encoder.encode(tail).length;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + tail;
}

/** 企业微信群机器人地址只认官方的 webhook 地址（防有人填一个内网地址让服务器去请求） */
export function isWecomWebhookUrl(url: string): boolean {
  return /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]{10,100}$/.test(url);
}
