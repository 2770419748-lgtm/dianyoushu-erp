import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 首次绑定拿着旧二维码（快核第 63 条后顺手修的边角，口径第 20 节）：真用模式下店长第一次登录要先绑定。
// 两个浏览器同时输了密码（各拿到一个二维码，后一个让前一个作废）：
// - 都还没绑上时，前一个输码 → 说二维码作废了，不算输错（原来就有）；
// - 后一个已经绑上以后，前一个再用旧二维码输码 → 以前提示“动态码不对”还算一次输错，现在也说作废了、不算输错。
// 用一个 emp 开头的店长账号（不是 e2e 用的 emp003），测完把绑定恢复原样、删掉测试留下的日志。cookie 用内存假的。

const jar = vi.hoisted(() => {
  process.env.DEMO_MODE = "0"; // 真用模式才强制首次绑定
  process.env.COOKIE_SECURE = "0";
  return { current: new Map<string, string>() };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.current.has(name) ? { name, value: jar.current.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.current.set(name, value),
    delete: (name: string) => void jar.current.delete(name),
  }),
  headers: async () => new Headers(),
}));

const { prisma } = await import("@/lib/prisma");
const { afterPassword, completeLoginWithCode } = await import("@/server/auth/mfa-service");
const { totpAt, totpStep } = await import("@/server/auth/totp");

let user: { id: number; sessionVersion: number; mfaSecretEnc: string | null; mfaEnabledAt: Date | null; mfaLastStep: number | null } | null = null;
const startedAt = new Date();

async function resetBinding() {
  if (user) await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null } });
}

beforeAll(async () => {
  try {
    user = await prisma.user.findFirst({
      where: { role: "STORE_MANAGER", isActive: true, username: { startsWith: "emp", not: "emp003" } },
      orderBy: { id: "asc" },
      select: { id: true, sessionVersion: true, mfaSecretEnc: true, mfaEnabledAt: true, mfaLastStep: true },
    });
  } catch {
    user = null;
  }
});

afterAll(async () => {
  if (user) {
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: user.mfaSecretEnc, mfaEnabledAt: user.mfaEnabledAt, mfaLastStep: user.mfaLastStep } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id, action: { in: ["user.mfa_enable", "login_failed"] }, createdAt: { gte: startedAt } } });
  }
  await prisma.$disconnect();
});

async function setupIn(cookieJar: Map<string, string>) {
  jar.current = cookieJar;
  const step = await afterPassword(user!.id, user!.sessionVersion);
  if (step.kind !== "setup") throw new Error(`应该先绑定，实际是 ${step.kind}`);
  return step.secret;
}

const failures = () => prisma.auditLog.count({ where: { userId: user!.id, action: "login_failed", createdAt: { gte: startedAt } } });

describe("首次绑定拿着旧二维码", () => {
  it("都还没绑上：前一个输码说作废，不算输错", async (ctx) => {
    if (!user) return ctx.skip();
    await resetBinding();
    const a = new Map<string, string>();
    const b = new Map<string, string>();
    const secretA = await setupIn(a);
    await setupIn(b);
    jar.current = a;
    const r = await completeLoginWithCode(totpAt(secretA, totpStep(new Date())), "test");
    expect(r).toMatchObject({ ok: false, restart: true });
    expect(!r.ok && r.error).toContain("又输过一次密码");
    expect(await failures()).toBe(0);
  });

  it("另一边已经绑上：旧二维码输码也说作废，不算输错", async (ctx) => {
    if (!user) return ctx.skip();
    await resetBinding();
    const a = new Map<string, string>();
    const b = new Map<string, string>();
    const secretA = await setupIn(a);
    const secretB = await setupIn(b);
    const step = totpStep(new Date());
    jar.current = b;
    expect(await completeLoginWithCode(totpAt(secretB, step), "test")).toMatchObject({ ok: true, enabled: true });
    jar.current = a;
    const r = await completeLoginWithCode(totpAt(secretA, step), "test");
    expect(r).toMatchObject({ ok: false, restart: true });
    expect(!r.ok && r.error).toContain("已经在别处");
    expect(a.has("erp_mfa")).toBe(false); // 旧票清掉了，要重新输密码
    expect(await failures()).toBe(0);
  });
});
