import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { canSell } from "@/server/auth/permissions";
import { assertStoreAccess } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { handleWecomCallback } from "./callback-service";
import { asTx, createSimulatedWecomClient, type Db, type WecomClient } from "./client";
import { SIMULATED_CALLBACK, type CallbackConfig, wecomMode } from "./config";
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

/** 销售单详情页的“模拟扫码加好友”：拿这张单的绑定码，假装客户扫了码 */
export async function simulateScanBindCode(user: CurrentUser, code: string, options: { db?: Db; client?: WecomClient; now?: Date } = {}) {
  if (wecomMode() !== "simulated") throw new WecomContactError("只有演示里的模拟模式能用“模拟扫码”");
  if (!canSell(user.role)) throw new WecomContactError("你的角色不能操作");
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const row = await db.wecomBindCode.findUnique({ where: { code }, include: { store: { select: { id: true, regionId: true } }, user: { select: { wecomUserid: true } } } });
  if (!row) throw new WecomContactError("二维码不存在");
  assertStoreAccess(user, row.store);
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
