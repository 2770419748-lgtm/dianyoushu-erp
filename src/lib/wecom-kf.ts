// 微信客服自动答复（口径第 12 节第三步）：认意图、抽机型、能不能发。纯函数，服务层、演示数据生成、单元测试共用（tests/wecom-kf.test.ts）。

/** 微信客服拉回来的一条消息（口径第 12 节第三步） */
export interface KfInboundMessage {
  msgid: string;
  openKfid: string;
  externalUserid: string;
  sendTime: Date;
  /** 3 客户发的，4 系统事件（会话状态变了），5 接待人员在企业微信里回的 */
  origin: number;
  msgType: string;
  text: string | null;
  event: { type: string; changeType: number | null } | null;
}

/** 把企业微信 sync_msg 返回的一条消息换成我们的格式（事件消息的客户 id 在 event 里） */
export function parseKfMessage(raw: Record<string, unknown>): KfInboundMessage {
  const event = (raw.event ?? null) as Record<string, unknown> | null;
  const text = (raw.text ?? null) as { content?: unknown } | null;
  return {
    msgid: String(raw.msgid ?? ""),
    openKfid: String(raw.open_kfid ?? event?.open_kfid ?? ""),
    externalUserid: String(raw.external_userid ?? event?.external_userid ?? ""),
    sendTime: new Date(Number(raw.send_time ?? 0) * 1000),
    origin: Number(raw.origin ?? 0),
    msgType: String(raw.msgtype ?? "unknown"),
    text: typeof text?.content === "string" ? text.content : null,
    event: event ? { type: String(event.event_type ?? ""), changeType: event.change_type === undefined ? null : Number(event.change_type) } : null,
  };
}

export type KfIntent = "HUMAN" | "MY_ENTITLEMENT" | "CLAIM" | "WARRANTY" | "REPAIR" | "HOURS" | "PRICE" | "UNKNOWN";

export const KF_INTENT_LABELS: Record<KfIntent, string> = {
  HUMAN: "转人工",
  MY_ENTITLEMENT: "我的保障",
  CLAIM: "理赔",
  WARRANTY: "保修政策",
  REPAIR: "手机坏了",
  HOURS: "营业时间和地址",
  PRICE: "价格和有没有货",
  UNKNOWN: "没听懂",
};

/** 企业微信的规定：客户发消息后 48 小时内能回；客户每发一次，最多回 5 条 */
export const KF_WINDOW_HOURS = 48;
export const KF_MAX_REPLIES = 5;
/** 连着几句没听懂就转人工 */
export const KF_MAX_MISSES = 2;
/** 客服消息留多久（每日任务删掉更早的） */
export const KF_RETENTION_DAYS = 180;

/**
 * 关键词规则，从上往下第一条命中的算数：先看要不要人工（投诉、退货、维修报价这些规则答不了），
 * 再看“我的保障”（比“保修政策”具体），理赔、保修、营业时间地址、价格库存。
 */
const RULES: [Exclude<KfIntent, "UNKNOWN">, RegExp][] = [
  ["HUMAN", /人工|真人|投诉|退货|退款|退钱|我想退|要退|换货|维修报价|(?<!保)修.{0,4}多少钱|找店长|转接/],
  ["MY_ENTITLEMENT", /我的(保障|保险|碎屏险|延保|保修)|(保险|碎屏险|延保|保修).{0,6}(到期|到什么时候|到哪天|还有多久|还剩|过期)|我.{0,8}买的.{0,10}(保修|保险|碎屏险|延保)/],
  ["CLAIM", /理赔|怎么赔|赔付|摔(坏|碎)|屏(幕)?(碎|裂)|(碎屏险|延保).{0,6}(怎么|如何)(用|赔)/],
  ["WARRANTY", /保修|三包|质保/],
  ["REPAIR", /坏了|坏掉|开不了机|开不开机|不开机|没反应|黑屏|花屏|进水|充不进电|要修|维修/],
  ["HOURS", /营业|几点|开门|关门|下班|地址|在哪|怎么走|门店|店在/],
  ["PRICE", /多少钱|价格|价钱|报价|售价|有货|有没有货|库存|现货|几多钱|卖多少/],
];

export function detectKfIntent(text: string): KfIntent {
  const t = text.trim();
  if (!t) return "UNKNOWN";
  for (const [intent, re] of RULES) if (re.test(t)) return intent;
  return "UNKNOWN";
}

/** 比较商品名用：小写、去掉空格和常见符号（“iPhone 16 Pro” 和 “iphone16pro” 当成一样） */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s\-_+·.,，。？?！!、]/g, "");
}

const FILLER = /多少钱|价格|价钱|报价|售价|有没有货|有货吗|有货|库存|现货|几多钱|卖多少|请问|你好|您好|想买|想问|一台|一部|现在|还|的|吗|呢|啊|呀|么/g;

/** 从“iPhone 16 Pro 多少钱”里抽出“iphone16pro”；抽不出两个字以上返回 null */
export function extractProductQuery(text: string): string | null {
  const q = normalizeName(text.replace(FILLER, ""));
  return q.length >= 2 ? q : null;
}

export interface ModelCandidate {
  id: number;
  name: string; // 型号名，如 “Mate 70”
  brand: string; // 品牌名，如 “华为”
}

/**
 * 按客户说的话找型号：话里包含型号名（“华为mate70多少钱” 包含 “mate70”），或型号名包含这句话（“iphone16” 是 “iPhone 16 Pro Max” 的一部分）。
 * 话里完整说出型号名的优先，越长越具体；只是型号名的一部分的，越短越接近。最多给 3 个。
 */
/** 客户常说的品牌叫法换成型号名里的写法（“苹果16”就是“iPhone 16”） */
const BRAND_ALIASES: [RegExp, string][] = [[/苹果|apple/g, "iphone"]];

export function applyBrandAliases(query: string): string {
  return BRAND_ALIASES.reduce((q, [re, to]) => (q.includes("iphone") ? q : q.replace(re, to)), query);
}

/** 话里完整说出了这个型号：型号名只有数字的（一加的“13”）要连牌子一起说才算，不然“13”谁都像 */
function saysModel(query: string, m: ModelCandidate): boolean {
  const name = normalizeName(m.name);
  const full = normalizeName(m.brand + m.name);
  return query.includes(full) || (!/^\d+$/.test(name) && query.includes(name));
}

/** 客户只说了型号的一部分（“pro”“13”），对上好几个牌子的型号：先问是哪个牌子，别一下列一堆 */
export function isAmbiguousModelQuery(models: ModelCandidate[], query: string): boolean {
  const q = applyBrandAliases(query);
  const said = models.some((m) => saysModel(q, m));
  if (said) return false;
  const matched = matchModels(models, query);
  return new Set(matched.map((m) => m.brand)).size > 1;
}

export function matchModels(models: ModelCandidate[], rawQuery: string): ModelCandidate[] {
  const query = applyBrandAliases(rawQuery);
  const said: { model: ModelCandidate; name: string }[] = [];
  const partial: { model: ModelCandidate; name: string }[] = [];
  for (const m of models) {
    const name = normalizeName(m.name);
    const full = normalizeName(m.brand + m.name);
    if (name.length < 2) continue;
    if (saysModel(query, m)) said.push({ model: m, name });
    else if (name.includes(query) || full.includes(query)) partial.push({ model: m, name });
  }
  if (said.length > 0) {
    // 说了“iPhone 16 Pro”，“iPhone 16”也算被说到了，但它只是更具体那个的一部分，去掉
    return said
      .filter((a) => !said.some((b) => b !== a && b.name.length > a.name.length && b.name.includes(a.name)))
      .sort((a, b) => b.name.length - a.name.length || a.model.id - b.model.id)
      .slice(0, 3)
      .map((s) => s.model);
  }
  return partial.sort((a, b) => a.name.length - b.name.length || a.model.id - b.model.id).slice(0, 3).map((s) => s.model);
}

/** 现在能不能给这个客户发消息：客户最后一次发消息在 48 小时内、之后回了不到 5 条 */
export function canSendKf(lastInAt: Date | null, outSinceIn: number, now: Date): { ok: true } | { ok: false; reason: string } {
  if (!lastInAt || now.getTime() - lastInAt.getTime() > KF_WINDOW_HOURS * 3600 * 1000) return { ok: false, reason: "客户 48 小时内没发过消息，不能主动发" };
  if (outSinceIn >= KF_MAX_REPLIES) return { ok: false, reason: `客户上次发消息后已经回了 ${KF_MAX_REPLIES} 条` };
  return { ok: true };
}

// ---------- 固定答复（演示口径，真用时按公司的实际政策改） ----------

export const KF_STORE_HOURS = "每天 9:30～21:30（节假日照常）";

export const KF_MENU_TEXT = "您可以问我：营业时间和地址、保修政策、碎屏险怎么理赔、某个机型多少钱有没有货、我的保障到什么时候。要找人工请回复“人工”。";

export const KF_WARRANTY_TEXT =
  "保修政策：在店里买的手机、平板，从购买当天起保修 12 个月（非人为损坏的质量问题免费修）；7 天内质量问题可以退换。进水、摔坏这类人为损坏不在保修里，买了碎屏险、延保的按保险来。带上机器到任意门店都能办。";

export const KF_CLAIM_TEXT =
  "碎屏险、延保理赔：带上机器到任意门店，店员按机器串号查到您的保障，在保障期内直接接件维修，不用先垫钱。碎屏险管屏幕碎裂，延保接在 12 个月保修后面、管非人为的质量问题。";

/** 转人工之前先发（企业微信只让“智能助手接待”状态下用接口发消息，转进待接入池以后就发不出去了），所以说“正在”，不说“已经” */
export const KF_HUMAN_TEXT = "好的，正在帮您转人工客服，请稍等，接待人员马上来。";

export const KF_HUMAN_FAILED_TEXT = "暂时转不了人工客服，麻烦直接打门店电话，或者稍后再发“人工”试试。";

export const KF_REPAIR_TEXT = "手机坏了可以带到任意门店接件检测：保修期内非人为的质量问题免费修，买了碎屏险、延保的按保险来，进水、摔坏这类人为损坏要先检测报价。要估价或预约请回复“人工”。";

export const KF_NEED_BIND_TEXT = "查保障要先核对身份：正在帮您转人工客服处理。也可以下次到店时扫店员的企业微信二维码，以后在这里就能直接查了。";
