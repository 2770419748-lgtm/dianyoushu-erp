import "server-only";
import { cookies } from "next/headers";
import { COOKIE_NAME, signSessionToken, verifySessionToken, type SessionPayload } from "./token";

const SESSION_DAYS = 7;

export async function createSession(userId: number): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const token = await signSessionToken({ userId }, expiresAt);
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true, // 页面脚本读不到，防 XSS 偷 cookie
    secure: process.env.NODE_ENV === "production", // 线上只走 HTTPS；本机 http 和手机局域网测试要放开
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
