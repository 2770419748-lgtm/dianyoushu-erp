import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { jwtVerify, SignJWT } from "jose";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import { decryptPii, encryptPii } from "@/server/pii/crypto";
import type { CurrentUser } from "./current-user";
import { DEMO_PROTECTED_MESSAGE, isProtectedDemoAccount } from "./demo-accounts";
import { mfaEnforced, mfaRequiredFor } from "./mfa-policy";
import { loginLimiter } from "./rate-limit";
import { createSession, shouldUseSecureCookie } from "./session";
import { sessionSigningKey } from "./token";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

// 二次验证（口径第 20 节）：店长、区域经理、总部登录时输完密码再输手机验证器 App 上的 6 位动态码。
// - 真用（DEMO_MODE=0）时强制：没绑定过的先绑定（扫二维码、输一次码确认）才能进系统；
// - 演示模式不强制（演示账号密码公开，绑了别人就登不上），但自己在“我的”页开了的照样要输；
// - 输完密码先发一张“待验证”票（单独的 cookie，不是登录票），输对动态码才发正式登录票：
//   输动态码限 5 分钟；第一次绑定要先装 App、扫码，限 15 分钟，票里记着是哪个二维码（换了新二维码，旧的作废）。

export class MfaError extends Error {}

export { mfaEnforced, mfaRequiredFor };

const TICKET_COOKIE = "erp_mfa";
const VERIFY_SECONDS = 5 * 60;
const SETUP_SECONDS = 15 * 60;
const TICKET_AUDIENCE = "erp-mfa"; // 带用途的票，verifySessionToken 不认它当登录票

type Ticket = { userId: number; sv: number; sid: string | null };

/** 二维码（密钥）的标识：密文的摘要前 16 位，票里带着它，换了新二维码就对不上 */
function secretId(secretEnc: string): string {
  return createHash("sha256").update(secretEnc).digest("hex").slice(0, 16);
}

async function setTicket(ticket: Ticket, seconds: number): Promise<void> {
  const token = await new SignJWT({ userId: ticket.userId, sv: ticket.sv, ...(ticket.sid ? { sid: ticket.sid } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(TICKET_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(sessionSigningKey());
  (await cookies()).set(TICKET_COOKIE, token, { httpOnly: true, secure: await shouldUseSecureCookie(), sameSite: "lax", maxAge: seconds, path: "/" });
}

async function readTicket(): Promise<Ticket | null> {
  const token = (await cookies()).get(TICKET_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSigningKey(), { algorithms: ["HS256"], audience: TICKET_AUDIENCE });
    if (typeof payload.userId !== "number" || typeof payload.sv !== "number") return null;
    return { userId: payload.userId, sv: payload.sv, sid: typeof payload.sid === "string" ? payload.sid : null };
  } catch {
    return null;
  }
}

async function clearTicket(): Promise<void> {
  (await cookies()).delete(TICKET_COOKIE);
}

/** 生成新密钥（加密存，还没开启），返回给页面显示的二维码和手动输入用的密钥 */
async function prepareSetup(user: { id: number; username: string }): Promise<{ qr: string; secret: string; sid: string }> {
  const secret = generateTotpSecret();
  const secretEnc = encryptPii(secret);
  await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: secretEnc, mfaEnabledAt: null, mfaLastStep: null } });
  return { secret, sid: secretId(secretEnc), qr: await QRCode.toDataURL(otpauthUri(secret, user.username), { margin: 1, width: 200 }) };
}

/**
 * 核对动态码并记下用过的时间窗。条件写入：同一个码两个请求同时来，只有一个算数。
 * enable=true 时（绑定确认）顺带记开启时间。对上返回 true。
 */
async function acceptCode(user: { id: number; mfaSecretEnc: string; mfaLastStep: number | null }, code: unknown, enable: boolean): Promise<boolean> {
  const step = verifyTotp(decryptPii(user.mfaSecretEnc), typeof code === "string" ? code : "", new Date(), user.mfaLastStep);
  if (step === null) return false;
  const done = await prisma.user.updateMany({
    where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
    data: { mfaLastStep: step, ...(enable ? { mfaEnabledAt: new Date() } : {}) },
  });
  return done.count === 1;
}

export type LoginStep = { kind: "done" } | { kind: "verify" } | { kind: "setup"; qr: string; secret: string };

/** 密码对了以后：直接登录、输动态码，还是先绑定 */
export async function afterPassword(userId: number, sessionVersion: number): Promise<LoginStep> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, username: true, role: true, mfaEnabledAt: true } });
  if (user.mfaEnabledAt) {
    await setTicket({ userId, sv: sessionVersion, sid: null }, VERIFY_SECONDS);
    return { kind: "verify" };
  }
  if (mfaEnforced() && mfaRequiredFor(user.role)) {
    const { sid, ...setup } = await prepareSetup(user);
    await setTicket({ userId, sv: sessionVersion, sid }, SETUP_SECONDS);
    return { kind: "setup", ...setup };
  }
  return { kind: "done" };
}

export type CodeResult = { ok: true; userId: number; enabled: boolean } | { ok: false; error: string; restart?: boolean };

/** 登录第二步：输动态码。对了发正式登录票；绑定中的这一步同时算开启 */
export async function completeLoginWithCode(code: unknown, ip: string): Promise<CodeResult> {
  const ticket = await readTicket();
  if (!ticket) return { ok: false, error: "输完密码太久了（输动态码限 5 分钟，第一次绑定限 15 分钟），请重新输一次密码", restart: true };
  const key = `mfa:${ticket.userId}`;
  // 先占名额再查库核对：同一张票同时发几百个码，也只有限额内的几个能去核对（2026-10-23 复查后补）
  const gate = loginLimiter.consume(key);
  if (!gate.allowed) return { ok: false, error: `动态码错太多次了，请 ${Math.max(1, Math.ceil(gate.retryAfterMs / 60000))} 分钟后再试` };
  const user = await prisma.user.findUnique({ where: { id: ticket.userId }, select: { id: true, isActive: true, sessionVersion: true, mfaSecretEnc: true, mfaEnabledAt: true, mfaLastStep: true } });
  if (!user || !user.isActive || user.sessionVersion !== ticket.sv || !user.mfaSecretEnc) {
    loginLimiter.refund(key);
    await clearTicket();
    return { ok: false, error: "登录已失效，请重新输一次密码", restart: true };
  }
  const enabling = user.mfaEnabledAt === null;
  // 绑定中又在别处输过一次密码：系统换了新二维码，手机上扫的旧的作废——说清楚，不算输错
  if (enabling && ticket.sid !== secretId(user.mfaSecretEnc)) {
    loginLimiter.refund(key);
    await clearTicket();
    return { ok: false, error: "这个二维码已经作废了：后来又输过一次密码，系统换了新的二维码。请重新输密码，在手机验证器里删掉旧的、扫新的", restart: true };
  }
  if (!(await acceptCode({ id: user.id, mfaSecretEnc: user.mfaSecretEnc, mfaLastStep: user.mfaLastStep }, code, enabling))) {
    // 输错已经在 consume 时记过了
    await writeAudit({ userId: user.id, action: "login_failed", detail: { reason: "动态码不对" }, ip });
    return { ok: false, error: "动态码不对：看手机验证器上这个账号现在的 6 位数（30 秒一换），换了就输新的" };
  }
  loginLimiter.reset(key);
  await clearTicket();
  await createSession(user.id, user.sessionVersion);
  if (enabling) await writeAudit({ userId: user.id, action: "user.mfa_enable", entity: "user", entityId: user.id, ip });
  return { ok: true, userId: user.id, enabled: enabling };
}

// ---------- “我的”页：自己开启 ----------

export async function getOwnMfaStatus(user: CurrentUser) {
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaEnabledAt: true } });
  return {
    enabledAt: row?.mfaEnabledAt ?? null,
    required: mfaEnforced() && mfaRequiredFor(user.role),
    canEnable: !isProtectedDemoAccount(user.username),
  };
}

/** 自己开启：先生成二维码，确认后才算开 */
export async function startOwnMfaSetup(user: CurrentUser): Promise<{ qr: string; secret: string }> {
  if (isProtectedDemoAccount(user.username)) throw new MfaError(DEMO_PROTECTED_MESSAGE);
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaEnabledAt: true } });
  if (row.mfaEnabledAt) throw new MfaError("已经开了二次验证；换手机要找总部重置后重新绑定");
  const { qr, secret } = await prepareSetup(user);
  return { qr, secret };
}

export async function confirmOwnMfaSetup(user: CurrentUser, code: unknown): Promise<void> {
  const key = `mfa:${user.id}`;
  const gate = loginLimiter.consume(key); // 先占名额再核对（同上）
  if (!gate.allowed) throw new MfaError(`动态码错太多次了，请 ${Math.max(1, Math.ceil(gate.retryAfterMs / 60000))} 分钟后再试`);
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, mfaSecretEnc: true, mfaEnabledAt: true, mfaLastStep: true } });
  if (row.mfaEnabledAt || !row.mfaSecretEnc) {
    loginLimiter.refund(key);
    throw new MfaError(row.mfaEnabledAt ? "已经开了二次验证" : "先点“开启二次验证”扫二维码");
  }
  if (!(await acceptCode({ id: row.id, mfaSecretEnc: row.mfaSecretEnc, mfaLastStep: row.mfaLastStep }, code, true))) {
    throw new MfaError("动态码不对：看手机验证器上这个账号现在的 6 位数");
  }
  loginLimiter.reset(key);
  await writeAudit({ userId: user.id, action: "user.mfa_enable", entity: "user", entityId: user.id });
}
