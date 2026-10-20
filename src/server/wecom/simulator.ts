import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { canSell } from "@/server/auth/permissions";
import { assertStoreAccess } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { handleWecomCallback } from "./callback-service";
import { asTx, createSimulatedWecomClient, type Db, type KfInboundMessage, type WecomClient } from "./client";
import { SIMULATED_CALLBACK, SIMULATED_KF_ID, type CallbackConfig, wecomMode } from "./config";
import { encryptWecomMessage, wecomSignature } from "./crypto";
import { WecomContactError } from "./contact-service";
import { buildWecomXml } from "./xml";

// 模拟扫码加好友（演示用，口径第 12 节）：不连企业微信，自己造一条“加好友”回调事件，
// 用模拟配置加密、签名，交给和真回调同一个处理函数：验签、解密、去重、按绑定码绑客户、发欢迎语（模拟）、写操作日志。

/** 造一条加密好的回调请求（单元测试也用它造事件） */
export function buildEncryptedCallback(fields: Record<string, string | number>, config: CallbackConfig, now: Date) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const nonce = String(Math.floor(Math.random() * 1e9));
  const encrypt = encryptWecomMessage(config.aesKey, buildWecomXml(fields), config.receiveId);
  const query = new URLSearchParams({ msg_signature: wecomSignature(config.token, timestamp, nonce, encrypt), timestamp, nonce });
  const body = buildWecomXml({ ToUserName: config.receiveId, Encrypt: encrypt, AgentID: "1000002" });
  return { method: "POST" as const, query, body };
}

export function contactEventFields(input: { changeType: string; userid: string; externalUserid: string; state?: string; welcomeCode?: string; config: CallbackConfig; now: Date }) {
  return {
    ToUserName: input.config.receiveId,
    FromUserName: "sys",
    CreateTime: Math.floor(input.now.getTime() / 1000),
    MsgType: "event",
    Event: "change_external_contact",
    ChangeType: input.changeType,
    UserID: input.userid,
    ExternalUserID: input.externalUserid,
    ...(input.state ? { State: input.state } : {}),
    ...(input.welcomeCode ? { WelcomeCode: input.welcomeCode } : {}),
  };
}

export { SIMULATED_KF_ID };

/**
 * 微信客服的演示（口径第 12 节第三步，总部）：把一条消息放进模拟的“企业微信消息队列”，再造一个 kf_msg_or_event 回调，
 * 交给真回调同一个处理函数：验签、解密、去重、按游标拉消息、认意图、答复或转人工。
 * - 客户发消息：已有会话就接着发；没有就新开一个模拟客户（已绑定档案的老客户，或者没绑定的新客户）；
 * - 接待人员回复（asServicer）：转人工之后，假装接待人员在企业微信里回了一句；
 * - 结束人工接待（endSession）：假装接待人员结束了会话，之后又恢复自动答复。
 */
export async function simulateKfMessage(
  user: CurrentUser,
  input: { externalUserid?: unknown; persona?: unknown; text?: unknown; asServicer?: unknown; endSession?: unknown },
  options: { db?: Db; now?: Date } = {},
) {
  if (wecomMode() !== "simulated") throw new WecomContactError("只有演示里的模拟模式能模拟客户发消息");
  if (user.role !== "HQ") throw new WecomContactError("微信客服只有总部能看");
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const endSession = input.endSession === true;
  const asServicer = input.asServicer === true;
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!endSession && (text.length === 0 || text.length > 500)) throw new WecomContactError("消息写 1～500 个字");

  let externalUserid = typeof input.externalUserid === "string" ? input.externalUserid : "";
  if (externalUserid) {
    const exists = await db.wecomKfSession.findUnique({ where: { openKfid_externalUserid: { openKfid: SIMULATED_KF_ID, externalUserid } } });
    if (!exists) throw new WecomContactError("这个会话不存在");
  } else if (asServicer || endSession) {
    throw new WecomContactError("先选一个会话");
  } else if (input.persona === "bound") {
    // 已绑定档案、买过碎屏险或延保的老客户，演示“我的保障”能答出来
    const candidates = await db.customer.findMany({ where: { wecomExternalUserid: { not: null }, entitlements: { some: { status: "ACTIVE" } } }, take: 50, select: { wecomExternalUserid: true } });
    if (candidates.length === 0) throw new WecomContactError("演示数据里没有绑定了微信的老客户");
    externalUserid = candidates[Math.floor(Math.random() * candidates.length)]!.wecomExternalUserid!;
  } else {
    externalUserid = `wmKfNew${randomBytes(5).toString("hex")}`;
  }

  const message: KfInboundMessage = endSession
    ? { msgid: `simev-${randomBytes(8).toString("hex")}`, openKfid: SIMULATED_KF_ID, externalUserid, sendTime: now, origin: 4, msgType: "event", text: null, event: { type: "session_status_change", changeType: 3 } }
    : { msgid: `simin-${randomBytes(8).toString("hex")}`, openKfid: SIMULATED_KF_ID, externalUserid, sendTime: now, origin: asServicer ? 5 : 3, msgType: "text", text, event: null };
  const fields = {
    ToUserName: SIMULATED_CALLBACK.receiveId,
    CreateTime: Math.floor(now.getTime() / 1000),
    MsgType: "event",
    Event: "kf_msg_or_event",
    Token: `simToken${randomBytes(6).toString("hex")}`,
    OpenKfId: SIMULATED_KF_ID,
  };
  const response = await handleWecomCallback(buildEncryptedCallback(fields, SIMULATED_CALLBACK, now), {
    config: SIMULATED_CALLBACK,
    client: createSimulatedWecomClient({ kfInbox: [message] }),
    db,
    now,
    simulated: true,
  });
  if (response.status !== 200 || !response.eventId) throw new WecomContactError(`模拟事件没处理成：${response.body}`);
  const event = await db.wecomEvent.findUniqueOrThrow({ where: { id: response.eventId } });
  if (event.status === "FAILED") throw new WecomContactError(`处理出错：${event.error ?? ""}`);
  const session = await db.wecomKfSession.findUniqueOrThrow({ where: { openKfid_externalUserid: { openKfid: SIMULATED_KF_ID, externalUserid } }, select: { id: true } });
  return { sessionId: session.id, externalUserid };
}

/** 销售单详情页的“模拟扫码加好友”：拿这张单的绑定码，假装客户扫了码 */
export async function simulateScanBindCode(user: CurrentUser, code: string, options: { db?: Db; client?: WecomClient; now?: Date } = {}) {
  if (wecomMode() !== "simulated") throw new WecomContactError("只有演示里的模拟模式能用“模拟扫码”");
  if (!canSell(user.role)) throw new WecomContactError("你的角色不能操作");
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const row = await db.wecomBindCode.findUnique({ where: { code }, include: { store: { select: { id: true, regionId: true } }, user: { select: { id: true, wecomUserid: true } } } });
  if (!row) throw new WecomContactError("二维码不存在");
  assertStoreAccess(user, row.store);
  // 和生成二维码时一样：店员只能动自己开的单（接待人 = 开单人），同店同事拿到码也不行
  if (user.role === "STAFF" && row.user.id !== user.id) throw new WecomContactError("店员只能给自己开的单模拟扫码");
  if (row.usedAt) throw new WecomContactError("这个二维码已经用过了");
  if (row.expiresAt <= now) throw new WecomContactError("这个二维码过期了，重新生成一个");
  if (!row.user.wecomUserid) throw new WecomContactError("开单人没有企业微信账号");

  const externalUserid = `wmSim${randomBytes(6).toString("hex")}`;
  const fields = contactEventFields({ changeType: "add_external_contact", userid: row.user.wecomUserid, externalUserid, state: code, welcomeCode: `simWelcome${randomBytes(6).toString("hex")}`, config: SIMULATED_CALLBACK, now });
  const response = await handleWecomCallback(buildEncryptedCallback(fields, SIMULATED_CALLBACK, now), {
    config: SIMULATED_CALLBACK,
    client: options.client ?? createSimulatedWecomClient(),
    db,
    now,
    simulated: true,
  });
  if (response.status !== 200 || !response.eventId) throw new WecomContactError(`模拟事件没处理成：${response.body}`);
  const event = await db.wecomEvent.findUniqueOrThrow({ where: { id: response.eventId } });
  await writeAudit({ userId: user.id, action: "wecom.simulate_scan", entity: "sales_order", entityId: row.salesOrderId, detail: { code, eventId: event.id, status: event.status } }, asTx(db));
  return { status: event.status, result: (event.payload as Record<string, string>)._result ?? event.error ?? "" };
}
