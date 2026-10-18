import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { findSessionUser } from "@/server/auth/session-user";
import { signSessionToken, verifySessionToken } from "@/server/auth/token";

// 登录令牌带会话版本号：和库里的不一致就当没登录（只读，不改库）。
// “重置密码后旧令牌失效”的完整流程会改库，在 tests/regression.db.test.ts 里。

let user: { id: number; sessionVersion: number } | null = null;

beforeAll(async () => {
  try {
    user = await prisma.user.findFirst({ where: { isActive: true, role: "STAFF" }, select: { id: true, sessionVersion: true }, orderBy: { id: "asc" } });
  } catch {
    user = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("会话版本号", () => {
  it("令牌里带版本号，验签后原样取回；旧令牌没有版本号按 0 算", async () => {
    const token = await signSessionToken({ userId: 7, sv: 3 }, new Date(Date.now() + 60_000));
    expect(await verifySessionToken(token)).toEqual({ userId: 7, sv: 3 });
  });

  it("版本号一致才算登录着；对不上（改过密码、停用过）就当没登录", async (ctx) => {
    if (!user) return ctx.skip();
    expect((await findSessionUser({ userId: user.id, sv: user.sessionVersion }))?.id).toBe(user.id);
    expect(await findSessionUser({ userId: user.id, sv: user.sessionVersion + 1 })).toBeNull();
    expect(await findSessionUser({ userId: 2147483000, sv: 0 })).toBeNull();
  });
});
