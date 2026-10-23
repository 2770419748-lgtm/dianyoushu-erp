import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { LOGIN_MAX_FAILURES } from "@/server/auth/rate-limit";
import { authenticate } from "@/server/auth/login-service";

// 登录限流不能被并发绕过（2026-10-23 复查第 58 条）：同一个账号同时发一堆错密码，只有限额内的几个真去核对，其余直接说“错误次数太多”。
// 用一个不存在的账号（核对一定失败），会在操作日志里留下几条“登录失败”。

afterAll(async () => {
  await prisma.$disconnect();
});

describe("登录限流（连本机库）", () => {
  it("同时发 50 个错密码：只核对了限额内的", async () => {
    const username = `ratetest_${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 50 }, () => authenticate(username, "wrong-password", "unknown")));
    const checked = results.filter((r) => !r.ok && r.error === "账号或密码不对").length;
    const blocked = results.filter((r) => !r.ok && r.error.includes("错误次数太多")).length;
    expect(checked).toBe(LOGIN_MAX_FAILURES);
    expect(blocked).toBe(50 - LOGIN_MAX_FAILURES);
    await prisma.auditLog.deleteMany({ where: { action: "login_failed", detail: { path: ["username"], equals: username } } });
  });
});
