"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { writeAudit } from "@/server/audit";
import { getCurrentUser } from "@/server/auth/current-user";
import { authenticate } from "@/server/auth/login-service";
import { afterPassword, completeLoginWithCode } from "@/server/auth/mfa-service";
import { createSession, destroySession } from "@/server/auth/session";

// 登录分两步（口径第 20 节）：密码对了，开了二次验证的再输动态码；真用时店长及以上没绑定的先绑定。
export type LoginState = { error?: string; step?: "verify" | "setup"; qr?: string; secret?: string };
export type MfaState = { error?: string; restart?: boolean };

async function clientIp(): Promise<string> {
  const h = await headers();
  // 来源 IP：在 Caddy 后面（TRUST_PROXY=1）时可信，用来按 IP 限流；直接对外时可能是伪造的，只记日志
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const ip = await clientIp();
  const result = await authenticate(String(formData.get("username") ?? ""), String(formData.get("password") ?? ""), ip);
  if (!result.ok) return { error: result.error };
  const next = await afterPassword(result.userId, result.sessionVersion);
  if (next.kind === "verify") return { step: "verify" };
  if (next.kind === "setup") return { step: "setup", qr: next.qr, secret: next.secret };
  await createSession(result.userId, result.sessionVersion);
  await writeAudit({ userId: result.userId, action: "login", ip });
  redirect("/");
}

export async function verifyMfa(_prev: MfaState, formData: FormData): Promise<MfaState> {
  const ip = await clientIp();
  const result = await completeLoginWithCode(formData.get("code"), ip);
  if (!result.ok) return { error: result.error, restart: result.restart };
  await writeAudit({ userId: result.userId, action: "login", detail: { mfa: true }, ip });
  redirect("/");
}

export async function logout(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await writeAudit({ userId: user.id, action: "logout" });
  redirect("/login");
}
