// 大模型写“今日待办”（口径第 18 节）：给模型的提示、解析模型返回的 JSON、数字校验、拼成 markdown。纯函数，单元测试见 tests/llm-digest.test.ts。
// 铁律：数字全部由程序算，模型只排先后、写成人话、给建议动作；模型写出来的每个数字都必须在交给它的清单里出现过。

import { ALERT_KIND_LABELS, type AlertDraft } from "./alerts";

export interface DigestPromptInput {
  title: string;
  items: Pick<AlertDraft, "kind" | "severity" | "title" | "detail" | "facts">[];
}

export interface DigestModelOutput {
  summary: string;
  items: { ref: number; text: string }[];
}

export const LLM_SYSTEM_PROMPT = [
  "你是手机零售门店的运营助理，帮店长把系统查出来的待办整理成“今日待办”。",
  "规则：",
  "1. 只能用清单里给的数字，不许自己算新的数字（不求和、不算百分比、不估计），不许写清单里没有的数字；拿不准就不写数字。",
  "2. 按轻重缓急排先后：影响收钱和对账的（日结、审批）最先，其次 KPI 和库存。",
  "3. 每条用一两句大白话说清楚是什么事、建议怎么做，像店长对店员说话；不要客套，不要加编号。",
  "4. 不要提客户姓名、手机号。",
  '5. 只输出 JSON：{"summary":"一句话总结今天最要紧的事","items":[{"ref":清单里的序号,"text":"这一条怎么说"}]}，每个序号最多出现一次。',
].join("\n");

/** 交给模型的清单：序号、轻重、类别、程序写的一句话、程序算好的数字。只有门店名、型号、台数、天数、金额，没有客户和员工的个人信息 */
export function buildDigestUserPrompt(input: DigestPromptInput): string {
  return JSON.stringify({
    标题: input.title,
    事项数: input.items.length,
    清单: input.items.map((item, i) => ({ 序号: i + 1, 轻重: item.severity === 3 ? "很急" : item.severity === 2 ? "要紧" : "一般", 类别: ALERT_KIND_LABELS[item.kind], 说明: item.detail, 数字: item.facts })),
  });
}

/** 文字里的数字：去掉千分位逗号，012 和 12 当成一样；百分号、单位不算 */
export function extractNumbers(text: string): string[] {
  const found = text.match(/\d+(?:[,，]\d{3})*(?:\.\d+)?/g) ?? [];
  return found.map((raw) => {
    const n = Number(raw.replace(/[,，]/g, ""));
    return Number.isFinite(n) ? String(n) : raw;
  });
}

/** 允许出现的数字：标题、事项数、每条的说明和数字里出现过的 */
export function allowedNumbers(input: DigestPromptInput): Set<string> {
  const texts = [input.title, String(input.items.length), ...input.items.flatMap((i) => [i.detail, ...Object.values(i.facts).map(String)])];
  return new Set(texts.flatMap(extractNumbers));
}

/** 模型写的数字里，不在清单上的（去重） */
export function unknownNumbers(output: DigestModelOutput, allowed: Set<string>): string[] {
  const used = [output.summary, ...output.items.map((i) => i.text)].flatMap(extractNumbers);
  return [...new Set(used.filter((n) => !allowed.has(n)))];
}

/** 解析模型返回的 JSON（有的模型会包一层 ```json），序号要在范围内、不重复，每条要有字 */
export function parseDigestJson(content: string, itemCount: number): { ok: true; value: DigestModelOutput } | { ok: false; reason: string } {
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "不是 JSON" };
  }
  const obj = data as { summary?: unknown; items?: unknown };
  if (!Array.isArray(obj.items)) return { ok: false, reason: "没有 items" };
  const seen = new Set<number>();
  const items: DigestModelOutput["items"] = [];
  for (const raw of obj.items as { ref?: unknown; text?: unknown }[]) {
    const ref = Number(raw?.ref);
    const itemText = typeof raw?.text === "string" ? raw.text.trim() : "";
    if (!Number.isInteger(ref) || ref < 1 || ref > itemCount) return { ok: false, reason: `序号 ${String(raw?.ref)} 不在清单里` };
    if (seen.has(ref)) return { ok: false, reason: `序号 ${ref} 重复了` };
    if (!itemText) return { ok: false, reason: `序号 ${ref} 没写内容` };
    if (itemText.length > 300) return { ok: false, reason: `序号 ${ref} 写得太长` };
    seen.add(ref);
    items.push({ ref, text: itemText });
  }
  if (items.length === 0) return { ok: false, reason: "一条都没写" };
  const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 200) : "";
  return { ok: true, value: { summary, items } };
}

/** 拼成 markdown：模型排的先后在前，模型漏掉的按程序的说法补在后面，结尾标来源 */
export function renderModelDigest(input: DigestPromptInput, output: DigestModelOutput, footer: string): string {
  const lines = output.items.map((item, i) => `${i + 1}. **${input.items[item.ref - 1]!.title}**：${item.text}`);
  const used = new Set(output.items.map((i) => i.ref));
  input.items.forEach((item, idx) => {
    if (!used.has(idx + 1)) lines.push(`${lines.length + 1}. **${item.title}**：${item.detail}`);
  });
  return `### ${input.title}\n${output.summary ? `${output.summary}\n\n` : ""}${lines.join("\n")}\n\n> ${footer}`;
}

/** 模拟模型的建议动作（不带数字，不会触发数字校验） */
const SIMULATED_ACTIONS: Record<string, string> = {
  STALE_DEVICES: "挑压得最久的几台做个活动，或者调去卖得快的店。",
  LOW_ACCESSORY: "今天就下单补货，别等卖断了。",
  KPI_BEHIND: "把主推机型和以旧换新一起推，晚上复盘一下进店转化。",
  DAILY_CLOSE: "先把这件事做完，钱对不上越晚越难查。",
  TRANSFER_PENDING: "联系发货店确认物流，到了马上点收货。",
  STOCKTAKE_OPEN: "盘完就确认，别让盘点单一直挂着。",
  TRADE_IN_IDLE: "安排人检测，合格的转良品上架。",
  APPROVAL_PENDING: "顾客可能在店里等着，尽快批。",
  TRANSFER_SUGGEST: "和对方店长打个招呼，发起调拨。",
  INTEGRITY: "先别动相关单据，让总部查明细。",
};

/**
 * 模拟模型（演示站没配大模型时用）：读清单，按轻重排序，在程序写的说明后面加一句建议，回一段和真模型同样格式的 JSON。
 * 它不碰数字，走的是和真模型同一套解析和校验。
 */
export function simulateDigestModel(userPrompt: string): string {
  const data = JSON.parse(userPrompt) as { 清单: { 序号: number; 轻重: string; 类别: string; 说明: string }[] };
  const rank: Record<string, number> = { 很急: 3, 要紧: 2, 一般: 1 };
  const kindOf = Object.fromEntries(Object.entries(ALERT_KIND_LABELS).map(([k, v]) => [v, k]));
  // 同样轻重时，按提示里说的先后：对账和钱的事、审批，再 KPI，再库存
  const order = ["INTEGRITY", "DAILY_CLOSE", "APPROVAL_PENDING", "KPI_BEHIND", "TRANSFER_PENDING", "LOW_ACCESSORY", "STALE_DEVICES", "TRANSFER_SUGGEST", "STOCKTAKE_OPEN", "TRADE_IN_IDLE"];
  const pos = (label: string) => order.indexOf(kindOf[label] ?? "");
  const sorted = [...data.清单].sort((a, b) => (rank[b.轻重] ?? 0) - (rank[a.轻重] ?? 0) || pos(a.类别) - pos(b.类别) || a.序号 - b.序号);
  const first = sorted[0];
  return JSON.stringify({
    summary: first ? `今天先处理“${first.类别}”${sorted.length > 1 ? "，其余的按下面的顺序来" : ""}。` : "",
    items: sorted.map((item) => ({ ref: item.序号, text: `${item.说明}。${SIMULATED_ACTIONS[kindOf[item.类别] ?? ""] ?? ""}` })),
  });
}
