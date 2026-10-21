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
  "1. 只能用清单里给的数字，不许自己算新的数字（不求和、不算百分比、不估计），不许写清单里没有的数字；拿不准就不写数字。每一条只能用这一条自己的数字。数字一律写成阿拉伯数字（写“2 台”，不写“两台”“三成”“十几天”）。",
  "2. 按轻重缓急排先后：影响收钱和对账的（日结、审批）最先，其次 KPI 和库存。",
  "3. 每条用一两句大白话说清楚是什么事、建议怎么做，像店长对店员说话；不要客套，不要加编号，不要换行，不要写标题、引用和链接。",
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

/** 全角的数字、小数点、百分号换成半角（“１２０ 台”就是“120 台”） */
export function toHalfWidth(text: string): string {
  return text.replace(/[０-９．％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** “二十”“十二”“一百零五”“两千”“三万”换成整数 */
export function chineseToInt(text: string): number {
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) num = CN_DIGITS[ch]!;
    else if (ch in CN_UNITS) {
      section += (num || 1) * CN_UNITS[ch]!;
      num = 0;
    } else if (ch === "万") {
      total += (section + num) * 10000;
      section = 0;
      num = 0;
    }
  }
  return total + section + num;
}

/**
 * 带量词的中文数字：“两台”“二十天”“三个月”“一万元”；“第一”这种序数、“一起”“一下”这种不是数量的不算；
 * 要有数字（单独一个“万”“百”不算，“8 万块”的 8 已经按阿拉伯数字核对了）。
 */
const CN_QUANTITY = /(?<![第\d])([零〇一二两三四五六七八九十百千万]*[零〇一二两三四五六七八九十][零〇一二两三四五六七八九十百千万]*)(?=[台个件天元块张份家人次周月年号倍条项单笔款]|小时|分钟|%)/g;
/** 说不出准数的说法：几台、十几天、二十多台、三成、一半、两三台——出现就不算数，改用模板 */
const CN_FUZZY = /[几数][十百千万]?[台个件天元块张份家人次周月年号倍条项单笔款]|[一二两三四五六七八九十]成|[十百千万][几多来余]|[一二两三四五六七八九][一二两三四五六七八九](?=[台个件天元块张份家人次周月年号倍条项单笔款十百千万])|一半|半数|大半|过半|近半/g;

/** “百分之三十”“百分之百”：换算成 30%、100% 再核对 */
const CN_PERCENT = /百分之([零〇一二两三四五六七八九十百]+)/g;
/** 不带单位、但明摆着是个数的中文数字：两个字以上、带“十”或“百”的（“完成率才六十”“一百二”）；“千万别”这种不算 */
const CN_BARE = /(?<![第\d零〇一二两三四五六七八九十百千万])([零〇一二两三四五六七八九十百千万]*[十百][零〇一二两三四五六七八九十百千万]*)(?![零〇一二两三四五六七八九十百千万])/g;

/** 文字里的数字：全角换半角、去掉千分位逗号，012 和 12 当成一样；带量词的、“百分之”后面的、不带单位但带十百的中文数字都换算成阿拉伯数字；百分号、单位不算 */
export function extractNumbers(text: string): string[] {
  const half = toHalfWidth(text).replace(CN_PERCENT, (_, n: string) => `${chineseToInt(n)}%`);
  const arabic = (half.match(/\d+(?:[,，]\d{3})*(?:\.\d+)?/g) ?? []).map((raw) => {
    const n = Number(raw.replace(/[,，]/g, ""));
    return Number.isFinite(n) ? String(n) : raw;
  });
  const seen = new Set<number>(); // 同一处中文数字只算一次
  const chinese: string[] = [];
  for (const re of [CN_QUANTITY, CN_BARE]) {
    for (const m of half.matchAll(re)) {
      if (re === CN_BARE && m[1]!.length < 2) continue;
      if (seen.has(m.index!)) continue;
      seen.add(m.index!);
      chinese.push(String(chineseToInt(m[1]!)));
    }
  }
  return [...arabic, ...chinese];
}

/** 说不出准数的中文说法（“十几天”“三成”“两三台”） */
export function fuzzyNumbers(text: string): string[] {
  return toHalfWidth(text).match(CN_FUZZY) ?? [];
}

/** 允许出现的数字：标题、事项数、每条的说明和数字里出现过的（总结可以用这些） */
export function allowedNumbers(input: DigestPromptInput): Set<string> {
  const texts = [input.title, String(input.items.length), ...input.items.flatMap((i) => [i.detail, ...Object.values(i.facts).map(String)])];
  return new Set(texts.flatMap(extractNumbers));
}

/** 某一条允许出现的数字：只能是这一条自己的说明和数字（日期里的 20、别的条目里的 68 不能拿来当台数） */
export function itemNumbers(item: DigestPromptInput["items"][number]): Set<string> {
  return new Set([item.detail, ...Object.values(item.facts).map(String)].flatMap(extractNumbers));
}

/**
 * 模型写的数字哪些不对（去重）：总结里的要在整份清单里；每一条里的只能是这一条自己的；
 * 说不出准数的中文说法（十几天、三成、两三台）一出现就算不对。返回空数组就是都对。
 */
export function numberProblems(input: DigestPromptInput, output: DigestModelOutput): string[] {
  const problems: string[] = [];
  const check = (text: string, allowed: Set<string>) => {
    problems.push(...fuzzyNumbers(text).map((f) => `“${f}”`));
    problems.push(...extractNumbers(text).filter((n) => !allowed.has(n)));
  };
  check(output.summary, allowedNumbers(input));
  for (const item of output.items) check(item.text, itemNumbers(input.items[item.ref - 1]!));
  return [...new Set(problems)];
}

/**
 * 模型写的一段话洗成一行纯文字再拼进待办和群消息：去掉换行、行首的 #（标题）和 >（引用）、markdown 链接只留文字、裸网址去掉、
 * 加粗和代码的符号去掉。企业微信群的 markdown 会把链接渲染成能点的，模型（或者被诱导的模型）写的链接不能带出去。
 */
export function cleanModelText(text: string): string {
  return text
    .replace(/\r?\n+/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<?\b(?:https?|ftp):\/\/[^\s<>）)]+>?/gi, "")
    .replace(/(^|\s)[#>]+\s*/g, "$1")
    .replace(/[*`_~]{1,3}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 报错原话里像密钥的串打码（sk-…、Bearer 后面的、32 位以上的字母数字串），存库、上页面之前都过一遍 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(sk|ak|key)[-_][A-Za-z0-9_-]{6,}/gi, (m) => `${m.slice(0, 3)}****`)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1****")
    .replace(/[A-Za-z0-9_-]{32,}/g, "****");
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
    const itemText = typeof raw?.text === "string" ? cleanModelText(raw.text) : "";
    if (!Number.isInteger(ref) || ref < 1 || ref > itemCount) return { ok: false, reason: `序号 ${String(raw?.ref)} 不在清单里` };
    if (seen.has(ref)) return { ok: false, reason: `序号 ${ref} 重复了` };
    if (!itemText) return { ok: false, reason: `序号 ${ref} 没写内容` };
    if (itemText.length > 300) return { ok: false, reason: `序号 ${ref} 写得太长` };
    seen.add(ref);
    items.push({ ref, text: itemText });
  }
  if (items.length === 0) return { ok: false, reason: "一条都没写" };
  const summary = typeof obj.summary === "string" ? cleanModelText(obj.summary).slice(0, 200) : "";
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
  STALE_DEVICES: "挑压得最久的先做个活动，或者调去卖得快的店。",
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
