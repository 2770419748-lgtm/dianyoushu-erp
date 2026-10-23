import { SignJWT, jwtVerify } from "jose";

// 会话令牌：用 SESSION_SECRET 签名的 JWT，放在 httpOnly cookie 里。
// 这个文件不依赖 next/headers，proxy.ts 和 session.ts 都能用。

export const COOKIE_NAME = "erp_session";

// sv = 签发时用户的会话版本号；和库里的对不上（改过密码、被停用过）就当没登录。旧令牌没有 sv，按 0 算
export type SessionPayload = { userId: number; sv: number };

/** 会话签名钥匙（SESSION_SECRET）：登录票、二次验证的待验证票都用它签 */
export function sessionSigningKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("缺少环境变量 SESSION_SECRET（至少 16 个字符），请在 .env 里配置");
  }
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(payload: SessionPayload, expiresAt: Date): Promise<string> {
  return new SignJWT({ userId: payload.userId, sv: payload.sv })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(sessionSigningKey());
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSigningKey(), { algorithms: ["HS256"] });
    if (payload.aud !== undefined) return null; // 带用途的票（比如企微侧边栏的）不是 ERP 登录票；侧边栏的密钥本来也不同，这里再挡一道
    const userId = payload.userId;
    if (typeof userId !== "number" || !Number.isInteger(userId)) return null;
    const sv = typeof payload.sv === "number" && Number.isInteger(payload.sv) ? payload.sv : 0;
    return { userId, sv };
  } catch {
    return null;
  }
}
