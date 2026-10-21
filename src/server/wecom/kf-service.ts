import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { entitlementStateLabel, daysUntil, warrantyEndsOn } from "@/lib/entitlement";
import { formatDate, formatFen } from "@/lib/format";
import {
  canSendKf,
  detectKfIntent,
  extractProductQuery,
  KF_CLAIM_TEXT,
  KF_HUMAN_FAILED_TEXT,
  KF_HUMAN_TEXT,
  KF_REPAIR_TEXT,
  isAmbiguousModelQuery,
  KF_MAX_MISSES,
  KF_MENU_TEXT,
  KF_NEED_BIND_TEXT,
  KF_RETENTION_DAYS,
  KF_STORE_HOURS,
  KF_WARRANTY_TEXT,
  type KfIntent,
  matchModels,
} from "@/lib/wecom-kf";
import type { CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { todayBizDate } from "@/server/stock/doc-no";
import type { Db, KfInboundMessage } from "./client";
import type { HandlerContext } from "./contact-service";

// 微信客服自动答复（口径第 12 节第三步）。
// 企业微信的回调只说“这个客服账号有新消息”（带一个 10 分钟有效的 token），系统按存库的游标去拉，拉完一页存一次游标；
// 每条消息按消息 id 去重，客户发来的文字按关键词认意图、答复；要人工、连着两句没听懂就转人工，之后不再自动答复。
// 发之前先查 48 小时、5 条的限制，超了不发、记下来。演示里的“模拟客户发消息”走同一套（simulator.ts 造回调）。

export class WecomKfError extends Error {}

export const KF_PAGE_SIZE = 30;

type Session = Awaited<ReturnType<typeof upsertSession>>;

async function upsertSession(db: Db, openKfid: string, externalUserid: string) {
  return db.wecomKfSession.upsert({
    where: { openKfid_externalUserid: { openKfid, externalUserid } },
    create: { openKfid, externalUserid },
    update: {},
  });
}

/** 企业微信 session_status_change 的 change_type */
const SESSION_CHANGES: Record<number, string> = { 1: "接待人员接入", 2: "转给别的接待人员", 3: "人工接待结束，恢复自动答复", 4: "重新接入人工" };

function describe(m: KfInboundMessage): string {
  if (m.msgType === "text") return (m.text ?? "").slice(0, 2000);
  if (m.msgType === "event") return m.event?.type === "session_status_change" ? `[${SESSION_CHANGES[m.event.changeType ?? 0] ?? "会话状态变了"}]` : `[事件 ${m.event?.type ?? ""}]`;
  const names: Record<string, string> = { image: "图片", voice: "语音", video: "视频", file: "文件", location: "位置", link: "链接", miniprogram: "小程序", msgmenu: "菜单" };
  return `[${names[m.msgType] ?? m.msgType}]`;
}

// ---------- 发消息 ----------

/** 发一条文字：先查 48 小时、5 条；超了不发，记一条“没发出去”。返回发没发出去 */
async function sendReply(ctx: HandlerContext, sessionId: number, text: string, note: string | null): Promise<boolean> {
  const session = await ctx.db.wecomKfSession.findUniqueOrThrow({ where: { id: sessionId } });
  const check = canSendKf(session.lastInAt, session.outSinceIn, ctx.now);
  if (!check.ok) {
    await ctx.db.wecomKfMessage.create({ data: { msgid: `unsent-${randomUUID()}`, sessionId, direction: "OUT", msgType: "text", content: text, delivered: false, note: check.reason, sentAt: ctx.now } });
    return false;
  }
  let msgid: string;
  try {
    msgid = (await ctx.client.sendKfText({ openKfid: session.openKfid, externalUserid: session.externalUserid, text })).msgid || `out-${randomUUID()}`;
  } catch (error) {
    await ctx.db.wecomKfMessage.create({
      data: { msgid: `unsent-${randomUUID()}`, sessionId, direction: "OUT", msgType: "text", content: text, delivered: false, note: `没发出去：${error instanceof Error ? error.message : String(error)}`.slice(0, 300), sentAt: ctx.now },
    });
    return false;
  }
  await ctx.db.wecomKfMessage.createMany({ data: [{ msgid, sessionId, direction: "OUT", msgType: "text", content: text, note, sentAt: ctx.now }], skipDuplicates: true });
  await ctx.db.wecomKfSession.update({ where: { id: sessionId }, data: { outSinceIn: Math.min(session.outSinceIn + 1, 5) } });
  return true;
}

// ---------- 答复内容 ----------

type Reply = { text: string; transfer?: boolean; miss?: boolean };

async function entitlementReply(db: Db, customerId: number): Promise<string> {
  const today = todayBizDate();
  const [entitlements, devices] = await Promise.all([
    db.serviceEntitlement.findMany({ where: { customerId, status: "ACTIVE" }, orderBy: { expiresOn: "asc" }, include: { sku: { select: { name: true } }, device: { select: { code: true } } } }),
    db.salesOrderItem.findMany({
      where: { order: { customerId, status: "COMPLETED" }, deviceId: { not: null }, returnedQty: 0 },
      orderBy: { id: "desc" },
      take: 5,
      select: { sku: { select: { name: true } }, device: { select: { code: true } }, order: { select: { bizDate: true } } },
    }),
  ]);
  const lines: string[] = [];
  for (const e of entitlements) {
    const daysLeft = daysUntil(e.expiresOn, today);
    if (daysLeft < 0) continue;
    const startIn = daysUntil(e.startedOn, today);
    const label = entitlementStateLabel(e.status, daysLeft, startIn);
    lines.push(`${e.sku.name}${e.device ? `（机器尾号 ${e.device.code.slice(-4)}）` : ""}：${label}${startIn > 0 ? `，${formatDate(e.startedOn)} 起` : ""}，到 ${formatDate(e.expiresOn)}`);
  }
  for (const d of devices) {
    const ends = warrantyEndsOn(d.order.bizDate);
    if (daysUntil(ends, today) >= 0) lines.push(`${d.sku.name}（尾号 ${d.device?.code.slice(-4) ?? ""}）：保修到 ${formatDate(ends)}`);
  }
  return lines.length > 0 ? `您在本店的保障：\n${lines.join("\n")}` : "您在本店还没有在保障期内的机器保修、碎屏险或延保。";
}

async function hoursReply(db: Db, customerId: number | null): Promise<string> {
  const last = customerId ? await db.salesOrder.findFirst({ where: { customerId, status: "COMPLETED" }, orderBy: { id: "desc" }, select: { store: { select: { name: true, address: true } } } }) : null;
  const stores = await db.store.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, take: 5, select: { name: true, address: true } });
  const head = `营业时间：${KF_STORE_HOURS}。`;
  if (last) return `${head}您上次是在${last.store.name}买的${last.store.address ? `，地址：${last.store.address}` : ""}。`;
  return `${head}\n${stores.map((s) => `${s.name}${s.address ? `：${s.address}` : ""}`).join("\n")}`;
}

async function priceReply(db: Db, text: string): Promise<Reply> {
  const query = extractProductQuery(text);
  if (!query) return { text: "想问哪个机型？比如回复“iPhone 16 Pro 多少钱”。", miss: true };
  const models = await db.productModel.findMany({ where: { isActive: true, skus: { some: { isActive: true, isService: false } } }, select: { id: true, name: true, brand: { select: { name: true } } } });
  const candidates = models.map((m) => ({ id: m.id, name: m.name, brand: m.brand.name }));
  if (isAmbiguousModelQuery(candidates, query)) return { text: "好几个牌子都有这个型号，是哪个牌子的？比如回复“小米 15 Pro 多少钱”。", miss: true };
  const matched = matchModels(candidates, query);
  if (matched.length === 0) return { text: "没找到这个机型，换个说法试试（比如“小米 15 多少钱”），或者回复“人工”。", miss: true };
  const lines: string[] = [];
  for (const m of matched) {
    const skus = await db.sku.findMany({ where: { modelId: m.id, isActive: true, isService: false }, select: { id: true, guidePriceFen: true } });
    const prices = skus.map((s) => s.guidePriceFen).filter((p) => p > 0);
    const skuIds = skus.map((s) => s.id);
    const [devices, accessories] = await Promise.all([
      db.device.findMany({ where: { skuId: { in: skuIds }, status: "IN_STOCK" }, distinct: ["storeId"], select: { store: { select: { region: { select: { name: true } } } } } }),
      db.accessoryStock.findMany({ where: { skuId: { in: skuIds }, qty: { gt: 0 } }, distinct: ["storeId"], select: { store: { select: { region: { select: { name: true } } } } } }),
    ]);
    const regions = [...new Set([...devices, ...accessories].map((d) => d.store.region.name))];
    const price = prices.length === 0 ? "价格到店问" : Math.min(...prices) === Math.max(...prices) ? `${formatFen(Math.min(...prices))} 元` : `${formatFen(Math.min(...prices))}～${formatFen(Math.max(...prices))} 元`;
    lines.push(`${m.brand} ${m.name}：指导价 ${price}，${regions.length > 0 ? `有货的区域：${regions.join("、")}` : "现在没货"}`);
  }
  return { text: `${lines.join("\n")}\n（不同容量颜色价格不同，门店可能有优惠，以门店为准）` };
}

async function composeReply(db: Db, intent: KfIntent, text: string, customerId: number | null, msgType: string): Promise<Reply> {
  if (msgType !== "text") return { text: `暂时只能看懂文字消息。${KF_MENU_TEXT}`, miss: true };
  switch (intent) {
    case "HUMAN":
      return { text: KF_HUMAN_TEXT, transfer: true };
    case "MY_ENTITLEMENT":
      return customerId ? { text: await entitlementReply(db, customerId) } : { text: KF_NEED_BIND_TEXT, transfer: true };
    case "CLAIM":
      return { text: KF_CLAIM_TEXT };
    case "WARRANTY":
      return { text: KF_WARRANTY_TEXT };
    case "REPAIR":
      return { text: KF_REPAIR_TEXT };
    case "HOURS":
      return { text: await hoursReply(db, customerId) };
    case "PRICE":
      return priceReply(db, text);
    case "UNKNOWN":
      return { text: `没太明白您的意思。${KF_MENU_TEXT}`, miss: true };
  }
}

// ---------- 处理一条拉回来的消息 ----------

type Outcome = "duplicate" | "skipped" | "event" | "servicer" | "human" | "replied" | "transferred";

/**
 * 转人工：先调企业微信的接口，成功了再告诉客户“已经转人工”；接口报错就告诉客户打门店电话，会话还是自动答复。
 * 不抛错：这一批里后面的消息照常处理。leadText 是转之前要先说的话（比如没绑定查保障的说明）。
 */
async function transfer(ctx: HandlerContext, session: Session, reason: string, leadText: string): Promise<boolean> {
  try {
    await ctx.client.transferKfToHuman({ openKfid: session.openKfid, externalUserid: session.externalUserid });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.db.wecomKfMessage.create({ data: { msgid: `note-${randomUUID()}`, sessionId: session.id, direction: "OUT", msgType: "event", content: "[转人工失败]", note: `${reason}；接口报错：${message}`.slice(0, 300), sentAt: ctx.now } });
    await ctx.db.wecomKfSession.update({ where: { id: session.id }, data: { missCount: 0 } });
    await sendReply(ctx, session.id, KF_HUMAN_FAILED_TEXT, "转人工没成功");
    return false;
  }
  await ctx.db.wecomKfSession.update({ where: { id: session.id }, data: { state: "HUMAN", humanAt: ctx.now, missCount: 0 } });
  await ctx.db.wecomKfMessage.create({ data: { msgid: `note-${randomUUID()}`, sessionId: session.id, direction: "OUT", msgType: "event", content: "[转人工]", note: reason, sentAt: ctx.now } });
  await sendReply(ctx, session.id, leadText, null);
  return true;
}

export async function handleKfMessage(ctx: HandlerContext, m: KfInboundMessage): Promise<Outcome> {
  if (!m.msgid || !m.openKfid || !m.externalUserid) return "skipped";
  const session = await upsertSession(ctx.db, m.openKfid, m.externalUserid);
  const inserted = await ctx.db.wecomKfMessage.createMany({
    data: [
      {
        msgid: m.msgid,
        sessionId: session.id,
        direction: m.origin === 5 ? "OUT" : "IN",
        msgType: m.msgType,
        content: describe(m),
        note: m.origin === 5 ? "接待人员在企业微信里回复" : m.origin === 4 ? "系统事件" : null,
        sentAt: m.sendTime,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return "duplicate";

  // 会话状态变了（企业微信的接待人员接入、转接、结束会话）
  if (m.origin === 4) {
    if (m.event?.type === "session_status_change") {
      if (m.event.changeType === 3) await ctx.db.wecomKfSession.update({ where: { id: session.id }, data: { state: "AUTO", missCount: 0, humanAt: null } });
      else await ctx.db.wecomKfSession.update({ where: { id: session.id }, data: { state: "HUMAN", humanAt: session.humanAt ?? ctx.now } });
    }
    return "event";
  }
  // 接待人员在企业微信里回的：也占 5 条的额度
  if (m.origin === 5) {
    await ctx.db.wecomKfSession.update({ where: { id: session.id }, data: { outSinceIn: Math.min(session.outSinceIn + 1, 5) } });
    return "servicer";
  }
  if (m.origin !== 3) return "skipped";

  // 客户发来的：先认人（这个微信绑定过客户档案才算），刷新 48 小时窗口
  const customerId = (await ctx.db.customer.findUnique({ where: { wecomExternalUserid: m.externalUserid }, select: { id: true } }))?.id ?? null;
  const current = await ctx.db.wecomKfSession.update({ where: { id: session.id }, data: { lastInAt: m.sendTime, outSinceIn: 0, customerId } });
  if (current.state === "HUMAN") {
    await ctx.db.wecomKfMessage.update({ where: { msgid: m.msgid }, data: { note: "人工接待中，不自动答复" } });
    return "human";
  }
  const text = m.msgType === "text" ? (m.text ?? "") : "";
  const intent: KfIntent = text ? detectKfIntent(text) : "UNKNOWN";
  await ctx.db.wecomKfMessage.update({ where: { msgid: m.msgid }, data: { intent } });
  const reply = await composeReply(ctx.db, intent, text, customerId, m.msgType);
  const misses = reply.miss ? current.missCount + 1 : 0;
  if (reply.miss && misses >= KF_MAX_MISSES) {
    return (await transfer(ctx, current, "连着两句没听懂", `还是没太明白，${KF_HUMAN_TEXT}`)) ? "transferred" : "replied";
  }
  await ctx.db.wecomKfSession.update({ where: { id: session.id }, data: { missCount: misses } });
  if (reply.transfer) {
    return (await transfer(ctx, current, intent === "MY_ENTITLEMENT" ? "没绑定档案，查保障要人工核对身份" : "客户要人工", reply.text)) ? "transferred" : "replied";
  }
  await sendReply(ctx, session.id, reply.text, null);
  return "replied";
}

/** 回调 kf_msg_or_event：按游标把新消息拉完（一页最多 1000 条，最多拉 20 页），逐条处理，拉完一页存一次游标 */
export async function onKfMsgOrEvent(fields: Record<string, string>, ctx: HandlerContext): Promise<string> {
  const openKfid = fields.OpenKfId ?? "";
  if (!openKfid) throw new Error("事件里缺 OpenKfId");
  const saved = await ctx.db.wecomKfCursor.findUnique({ where: { openKfid } });
  let cursor = saved?.cursor ?? null;
  const counts: Record<Outcome, number> = { duplicate: 0, skipped: 0, event: 0, servicer: 0, human: 0, replied: 0, transferred: 0 };
  for (let page = 0; page < 20; page++) {
    const result = await ctx.client.syncKfMessages({ token: fields.Token ?? "", openKfid, cursor });
    for (const m of result.messages) counts[await handleKfMessage(ctx, m)]++;
    cursor = result.nextCursor;
    await ctx.db.wecomKfCursor.upsert({ where: { openKfid }, create: { openKfid, cursor }, update: { cursor } });
    if (!result.hasMore) break;
  }
  return `微信客服：自动答复 ${counts.replied} 条，转人工 ${counts.transferred} 个，人工接待中 ${counts.human} 条，重复 ${counts.duplicate} 条`;
}

// ---------- 每日清理 ----------

/** 客服消息留 180 天；会话没有消息了也删 */
export async function cleanupKfMessages(options: { db?: Db; now?: Date } = {}) {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const before = new Date(now.getTime() - KF_RETENTION_DAYS * 24 * 3600 * 1000);
  const messages = await db.wecomKfMessage.deleteMany({ where: { sentAt: { lt: before } } });
  const sessions = await db.wecomKfSession.deleteMany({ where: { messages: { none: {} }, updatedAt: { lt: before } } });
  return { messages: messages.count, sessions: sessions.count };
}

// ---------- 页面（总部） ----------

function assertHq(user: CurrentUser) {
  if (user.role !== "HQ") throw new PermissionError("微信客服的会话只有总部能看");
}

export async function listKfSessions(user: CurrentUser) {
  assertHq(user);
  const sessions = await prisma.wecomKfSession.findMany({
    orderBy: { updatedAt: "desc" },
    take: KF_PAGE_SIZE,
    include: {
      customer: { select: { id: true, name: true } },
      messages: { orderBy: [{ sentAt: "desc" }, { id: "desc" }], take: 1, select: { content: true, sentAt: true, direction: true } },
      _count: { select: { messages: true } },
    },
  });
  const [total, human] = await Promise.all([prisma.wecomKfSession.count(), prisma.wecomKfSession.count({ where: { state: "HUMAN" } })]);
  return {
    total,
    human,
    sessions: sessions.map((s) => ({
      id: s.id,
      externalUserid: s.externalUserid,
      customer: s.customer,
      state: s.state,
      lastInAt: s.lastInAt,
      updatedAt: s.updatedAt,
      last: s.messages[0] ?? null,
      count: s._count.messages,
    })),
  };
}

export async function getKfSession(user: CurrentUser, id: number) {
  assertHq(user);
  const session = await prisma.wecomKfSession.findUnique({
    where: { id },
    include: { customer: { select: { id: true, name: true } }, messages: { orderBy: [{ sentAt: "asc" }, { id: "asc" }], take: 200 } },
  });
  if (!session) return null;
  return {
    ...session,
    window: canSendKf(session.lastInAt, session.outSinceIn, new Date()),
    messages: session.messages.map((m) => ({ id: m.id, direction: m.direction, msgType: m.msgType, content: m.content, intent: m.intent, delivered: m.delivered, note: m.note, sentAt: m.sentAt })),
  };
}

export type KfSessionList = Awaited<ReturnType<typeof listKfSessions>>;
export type KfSessionDetail = NonNullable<Awaited<ReturnType<typeof getKfSession>>>;
