import "server-only";
import { cookies, headers } from "next/headers";
import { COOKIE_NAME, signSessionToken, verifySessionToken, type SessionPayload } from "./token";

const SESSION_DAYS = 7;

/**
 * cookie 要不要加 Secure（只在 HTTPS 下发送）：看这次请求实际是不是 HTTPS。
 * 线上 Caddy 做 HTTPS，会带 X-Forwarded-Proto: https；备案前先用 http://服务器IP 演示时是 http，
 * 如果一律按“生产环境就加 Secure”，浏览器会丢掉 cookie，怎么都登录不进去。
 * 也可以用环境变量 COOKIE_SECURE=1 / 0 强制。
 */
async function shouldUseSecureCookie(): Promise<boolean> {
  if (process.env.COOKIE_SECURE === "1") return true;
  if (process.env.COOKIE_SECURE === "0") return false;
  const proto = (await headers()).get("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https";
}

export async function createSession(userId: number, sessionVersion: number): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const token = await signSessionToken({ userId, sv: sessionVersion }, expiresAt);
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true, // 页面脚本读不到，防 XSS 偷 cookie
    secure: await shouldUseSecureCookie(),
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export async function readSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(COOKIE_NAME)?.value);
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
