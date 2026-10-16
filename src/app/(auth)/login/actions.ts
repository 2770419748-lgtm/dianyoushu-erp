"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/server/auth/password";
import { loginLimiter } from "@/server/auth/rate-limit";
import { createSession, destroySession } from "@/server/auth/session";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "请输入账号和密码" };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limiterKey = `${username.toLowerCase()}@${ip}`;

  const gate = loginLimiter.check(limiterKey);
  if (!gate.allowed) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfterMs / 60000));
    return { error: `错误次数太多，请 ${minutes} 分钟后再试` };
  }

  const user = await prisma.user.findUnique({ where: { username } });
  const ok = user !== null && user.isActive && (await verifyPassword(password, user.passwordHash));
  if (!ok) {
    loginLimiter.recordFailure(limiterKey);
    return { error: "账号或密码不对" };
  }

  loginLimiter.reset(limiterKey);
  await createSession(user.id);
  redirect("/");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}
