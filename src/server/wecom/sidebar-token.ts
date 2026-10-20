import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

// 企微侧边栏的票（口径第 12 节第三步）：和 ERP 登录分开。
// - 单独的 cookie（只在 /wecom-app 下发送），2 小时过期；
// - 签名密钥从 SESSION_SECRET 派生出另一把，ERP 拿它验签一定失败；票里再写明用途（aud），两边互相不认；
// - 票里记员工 id、会话版本号和企业微信账号：ERP 账号停用、改密码、企业微信账号改了，这张票都作废（每次用都查库核对）。

export const SIDEBAR_COOKIE = "wecom_sidebar";
export const SIDEBAR_COOKIE_PATH = "/wecom-app";
export const SIDEBAR_TTL_MS = 2 * 3600 * 1000;
/** 网页授权时防伪造跳转的 state，10 分钟内有效 */
export const SIDEBAR_STATE_COOKIE = "wecom_sidebar_state";
const AUDIENCE = "wecom-sidebar";

export type SidebarPayload = { userId: number; sv: number; wecomUserid: string };

function sidebarKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("缺少环境变量 SESSION_SECRET（至少 16 个字符），请在 .env 里配置");
  return createHash("sha256").update(`wecom-sidebar:${secret}`).digest();
}

export async function signSidebarToken(payload: SidebarPayload, expiresAt: Date): Promise<string> {
  return new SignJWT({ userId: payload.userId, sv: payload.sv, wecomUserid: payload.wecomUserid })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(sidebarKey());
}

export async function verifySidebarToken(token: string | undefined): Promise<SidebarPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sidebarKey(), { algorithms: ["HS256"], audience: AUDIENCE });
    const { userId, sv, wecomUserid } = payload;
    if (typeof userId !== "number" || !Number.isInteger(userId) || typeof sv !== "number" || typeof wecomUserid !== "string" || !wecomUserid) return null;
    return { userId, sv, wecomUserid };
  } catch {
    return null;
  }
}
