"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { writeAudit } from "@/server/audit";
import { getCurrentUser } from "@/server/auth/current-user";
import { authenticate } from "@/server/auth/login-service";
import { createSession, destroySession } from "@/server/auth/session";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const h = await headers();
  // 来源 IP：在 Caddy 后面（TRUST_PROXY=1）时可信，用来按 IP 限流；直接对外时可能是伪造的，只记日志
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const result = await authenticate(String(formData.get("username") ?? ""), String(formData.get("password") ?? ""), ip);
  if (!result.ok) return { error: result.error };
  await createSession(result.userId, result.sessionVersion);
  redirect("/");
}

export async function logout(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await writeAudit({ userId: user.id, action: "logout" });
  redirect("/login");
}
