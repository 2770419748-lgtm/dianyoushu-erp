import { SignJWT, jwtVerify } from "jose";

// 会话令牌：用 SESSION_SECRET 签名的 JWT，放在 httpOnly cookie 里。
// 这个文件不依赖 next/headers，proxy.ts 和 session.ts 都能用。

export const COOKIE_NAME = "erp_session";

export type SessionPayload = { userId: number };

function getKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("缺少环境变量 SESSION_SECRET（至少 16 个字符），请在 .env 里配置");
  }
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(payload: SessionPayload, expiresAt: Date): Promise<string> {
  return new SignJWT({ userId: payload.userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(getKey());
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getKey(), { algorithms: ["HS256"] });
    const userId = payload.userId;
    if (typeof userId !== "number" || !Number.isInteger(userId)) return null;
    return { userId };
  } catch {
    return null;
  }
}
