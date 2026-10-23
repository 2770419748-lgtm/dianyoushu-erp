import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { mfaRequiredFor } from "@/server/auth/mfa-service";
import { needsMfaBinding } from "@/server/auth/mfa-policy";
import { resetUserMfa } from "@/server/org/org-service";
import { encryptPii } from "@/server/pii/crypto";

// 二次验证（口径第 20 节，连本机库，事务回滚）：谁要验证；总部重置别人的绑定（写原因、下线、记日志），自己的不能自己重置。
// 登录两步的整条流程在 tests/e2e/mfa.spec.ts 用浏览器测。

class Rollback extends Error {}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let hq: CurrentUser | null = null;

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

beforeAll(async () => {
  try {
    const row = await prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } });
    hq = row ? ({ ...row, store: null, region: null } as unknown as CurrentUser) : null;
  } catch {
    hq = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("二次验证", () => {
  it("店长、区域经理、总部要；店员不用", () => {
    expect(mfaRequiredFor("STAFF")).toBe(false);
    expect(mfaRequiredFor("STORE_MANAGER")).toBe(true);
    expect(mfaRequiredFor("REGIONAL_MANAGER")).toBe(true);
    expect(mfaRequiredFor("HQ")).toBe(true);
  });

  it("真用时店长及以上没绑的，手里的老登录票不算数（店员改成店长、演示切到真用以后）", () => {
    expect(needsMfaBinding("STORE_MANAGER", null, true)).toBe(true);
    expect(needsMfaBinding("HQ", null, true)).toBe(true);
    expect(needsMfaBinding("STORE_MANAGER", new Date(), true)).toBe(false);
    expect(needsMfaBinding("STAFF", null, true)).toBe(false);
    expect(needsMfaBinding("HQ", null, false)).toBe(false); // 演示模式不强制
  });

  it("总部重置别人的：要写原因；清掉绑定、所有设备下线、记日志；自己的、没绑定的不行", async (ctx) => {
    if (!hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const target = await tx.user.create({ data: { username: "mfatest_m", passwordHash: "x", name: "二次验证测试店长", role: "STORE_MANAGER", mfaSecretEnc: encryptPii("JBSWY3DPEHPK3PXP"), mfaEnabledAt: new Date(), mfaLastStep: 123 } });
      await expect(resetUserMfa({ ...me, role: "STORE_MANAGER" }, target.id, "换手机", tx)).rejects.toThrow("只有总部");
      await expect(resetUserMfa(me, target.id, " ", tx)).rejects.toThrow("写一下为什么");
      await expect(resetUserMfa(me, me.id, "换手机", tx)).rejects.toThrow("另一个总部");
      await resetUserMfa(me, target.id, "换手机", tx);
      expect(await tx.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, sessionVersion: target.sessionVersion + 1 });
      expect(await tx.auditLog.findFirst({ where: { action: "user.mfa_reset", entityId: String(target.id) } })).toMatchObject({ userId: me.id, detail: { reason: "换手机" } });
      await expect(resetUserMfa(me, target.id, "换手机", tx)).rejects.toThrow("还没绑定");
    });
  });

  it("数据库约束：密钥只能是密文，开了就要有密钥", async (ctx) => {
    if (!hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const u = await tx.user.create({ data: { username: "mfatest_c", passwordHash: "x", name: "约束测试", role: "STORE_MANAGER" } });
      await expect(tx.$executeRaw`UPDATE users SET mfa_secret_enc = 'JBSWY3DPEHPK3PXP' WHERE id = ${u.id}`).rejects.toThrow();
    });
    await inRolledBackTx(async (tx) => {
      const u = await tx.user.create({ data: { username: "mfatest_d", passwordHash: "x", name: "约束测试", role: "STORE_MANAGER" } });
      await expect(tx.$executeRaw`UPDATE users SET mfa_enabled_at = now() WHERE id = ${u.id}`).rejects.toThrow();
    });
  });
});
