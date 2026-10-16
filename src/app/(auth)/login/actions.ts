"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import { getCurrentUser } from "@/server/auth/current-user";
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
    await writeAudit({ userId: user?.id ?? null, action: "login_failed", detail: { username }, ip });
    return { error: "账号或密码不对" };
  }

  loginLimiter.reset(limiterKey);
  await createSession(user.id);
  await writeAudit({ userId: user.id, action: "login", ip });
  redirect("/");
}

export async function logout(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await writeAudit({ userId: user.id, action: "logout" });
  redirect("/login");
}
