import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { type Db, type WecomClient } from "./client";
import { CALLBACK_MAX_SKEW_SECONDS, type CallbackConfig } from "./config";
import { decryptWecomMessage, sha256Hex, verifyWecomSignature, WecomCryptoError } from "./crypto";
import { onAddExternalContact, onDeleteFollow, type HandlerContext } from "./contact-service";
import { parseWecomXml } from "./xml";

// 企业微信回调（口径第 12 节）：验签 → 解密 → 事件落库（去重）→ 分发处理 → 回 success。
// 企业微信 5 秒内收不到响应会重试，所以：先落库再处理；去重键用解密后整段明文的 sha256（重试时明文一样）；
// 时间戳和服务器差 5 分钟以上的拒收（防有人把抓到的请求再发一遍）；签名不对直接 403，不落库。
// 演示里的“模拟扫码加好友”也走这一个函数，只是配置换成模拟的那套。

export interface CallbackRequest {
  method: "GET" | "POST";
  query: URLSearchParams;
  body: string;
}

export interface CallbackResponse {
  status: number;
  body: string;
  eventId?: number;
  duplicate?: boolean;
}

type Handler = (fields: Record<string, string>, ctx: HandlerContext) => Promise<string>;

/** 按 “Event:ChangeType” 分发；没登记的事件也落库，标成处理完 */
const HANDLERS: Record<string, Handler> = {
  "change_external_contact:add_external_contact": onAddExternalContact,
  "change_external_contact:del_external_contact": (f, ctx) => onDeleteFollow(f, "EMPLOYEE", ctx),
  "change_external_contact:del_follow_user": (f, ctx) => onDeleteFollow(f, "CUSTOMER", ctx),
};

export async function handleWecomCallback(
  request: CallbackRequest,
  options: { config: CallbackConfig; client: WecomClient; db?: Db; now?: Date; simulated?: boolean },
): Promise<CallbackResponse> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const signature = request.query.get("msg_signature") ?? "";
  const timestamp = request.query.get("timestamp") ?? "";
  const nonce = request.query.get("nonce") ?? "";
  if (!signature || !/^\d{1,12}$/.test(timestamp) || !nonce) return { status: 400, body: "缺少签名参数" };
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > CALLBACK_MAX_SKEW_SECONDS) return { status: 403, body: "时间戳过期" };

  // URL 验证：企业微信后台保存回调地址时发一个 GET，要原样回解密后的 echostr
  if (request.method === "GET") {
    const echostr = request.query.get("echostr") ?? "";
    if (!verifyWecomSignature(signature, options.config.token, timestamp, nonce, echostr)) return { status: 403, body: "签名不对" };
    try {
      return { status: 200, body: decryptWecomMessage(options.config.aesKey, echostr, options.config.receiveId) };
    } catch (error) {
      if (error instanceof WecomCryptoError) return { status: 400, body: error.message };
      throw error;
    }
  }

  const encrypt = parseWecomXml(request.body).Encrypt ?? "";
  if (!encrypt) return { status: 400, body: "没有密文" };
  if (!verifyWecomSignature(signature, options.config.token, timestamp, nonce, encrypt)) return { status: 403, body: "签名不对" };
  let plain: string;
  try {
    plain = decryptWecomMessage(options.config.aesKey, encrypt, options.config.receiveId);
  } catch (error) {
    if (error instanceof WecomCryptoError) return { status: 400, body: error.message };
    throw error;
  }
  const fields = parseWecomXml(plain);
  const eventType = fields.Event || fields.MsgType || "unknown";
  const changeType = fields.ChangeType || null;

  // 落库去重：ON CONFLICT DO NOTHING，重复的直接回 success（不在事务里抛唯一约束错，测试的回滚事务也不会被打断）
  const eventKey = sha256Hex(plain);
  const inserted = await db.wecomEvent.createMany({
    data: [{ eventKey, source: "CONTACT", simulated: options.simulated ?? false, eventType, changeType, payload: fields as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
  const event = await db.wecomEvent.findUniqueOrThrow({ where: { eventKey }, select: { id: true } });
  if (inserted.count === 0) return { status: 200, body: "success", eventId: event.id, duplicate: true };

  const handler = HANDLERS[`${eventType}:${changeType ?? ""}`];
  try {
    const note = handler ? await handler(fields, { db, client: options.client, now, simulated: options.simulated ?? false }) : "这类事件这一版不处理";
    await db.wecomEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date(), error: null, payload: { ...fields, _result: note } as Prisma.InputJsonValue } });
  } catch (error) {
    // 处理失败也回 success：事件已经落库，标 FAILED 留给每日脚本重放；回非 200 企业微信只会重试同一条
    await db.wecomEvent.update({ where: { id: event.id }, data: { status: "FAILED", processedAt: new Date(), error: error instanceof Error ? error.message.slice(0, 500) : String(error) } });
  }
  return { status: 200, body: "success", eventId: event.id };
}

/** 每日脚本：处理失败的事件再跑一遍（处理都是幂等的：跟进关系 upsert、绑定码只能用一次） */
export async function replayFailedEvents(options: { client: WecomClient; db?: Db; now?: Date }) {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const failed = await db.wecomEvent.findMany({ where: { status: "FAILED", simulated: false }, orderBy: { id: "asc" }, take: 200 });
  let fixed = 0;
  for (const event of failed) {
    const fields = event.payload as Record<string, string>;
    const handler = HANDLERS[`${event.eventType}:${event.changeType ?? ""}`];
    if (!handler) continue;
    try {
      const note = await handler({ ...fields, WelcomeCode: "" }, { db, client: options.client, now, simulated: false }); // 欢迎语的 code 早过期了，不再发
      await db.wecomEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date(), error: null, payload: { ...fields, _result: `重放：${note}` } as Prisma.InputJsonValue } });
      fixed++;
    } catch (error) {
      await db.wecomEvent.update({ where: { id: event.id }, data: { error: `重放失败：${error instanceof Error ? error.message.slice(0, 480) : String(error)}` } });
    }
  }
  return { total: failed.length, fixed };
}
