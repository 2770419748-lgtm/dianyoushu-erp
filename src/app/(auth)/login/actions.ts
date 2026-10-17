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
  // IP 只用来记日志（没有反向代理时这个头可以伪造，所以不拿它做限流）
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const result = await authenticate(String(formData.get("username") ?? ""), String(formData.get("password") ?? ""), ip);
  if (!result.ok) return { error: result.error };
  await createSession(result.userId);
  redirect("/");
}

export async function logout(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await writeAudit({ userId: user.id, action: "logout" });
  redirect("/login");
}
