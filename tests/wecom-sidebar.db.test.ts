import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { createSimulatedWecomClient } from "@/server/wecom/client";
import { claimFromSidebar, getSidebarProfile, issueSidebarToken, type SidebarUser, sidebarUserFromToken } from "@/server/wecom/sidebar-service";
import { signSidebarToken } from "@/server/wecom/sidebar-token";

// 企微侧边栏（口径第 12 节第三步，连本机库）：票换人要核对会话版本和企业微信账号；只能看自己的好友；按完整手机号认领。
// 画像只读演示数据；认领在事务里做、最后回滚，不留数据。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let staff: SidebarUser | null = null;
let mine: { bound: string | null } = { bound: null };
let othersFollow: string | null = null;

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
  process.env.SESSION_SECRET ??= "test-session-secret-0123456789";
  try {
    const user = await prisma.user.findFirst({ where: { role: "STAFF", isActive: true, wecomUserid: { not: null }, wecomFollows: { some: { status: "ACTIVE", customerId: { not: null } } } }, orderBy: { id: "asc" } });
    if (!user?.wecomUserid) return;
    const token = (await issueSidebarToken({ id: user.id })).token;
    staff = await sidebarUserFromToken(token);
    const bound = await prisma.wecomFollow.findFirst({ where: { wecomUserid: user.wecomUserid, status: "ACTIVE", customer: { wecomExternalUserid: { not: null } } }, select: { externalUserid: true } });
    mine = { bound: bound?.externalUserid ?? null };
    othersFollow = (await prisma.wecomFollow.findFirst({ where: { wecomUserid: { not: user.wecomUserid }, status: "ACTIVE", NOT: { externalUserid: { in: (await prisma.wecomFollow.findMany({ where: { wecomUserid: user.wecomUserid }, select: { externalUserid: true } })).map((f) => f.externalUserid) } } }, select: { externalUserid: true } }))?.externalUserid ?? null;
  } catch {
    staff = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("企微侧边栏（连本机库）", () => {
  it("票换人：会话版本号、企业微信账号对不上都不认", async (ctx) => {
    if (!staff) return ctx.skip();
    expect(staff.wecomUserid).toBeTruthy();
    const later = new Date(Date.now() + 3600 * 1000);
    expect(await sidebarUserFromToken(await signSidebarToken({ userId: staff.id, sv: 999, wecomUserid: staff.wecomUserid }, later))).toBeNull();
    expect(await sidebarUserFromToken(await signSidebarToken({ userId: staff.id, sv: 0, wecomUserid: "someone-else" }, later))).toBeNull();
  });

  it("只能看自己的企业微信好友；绑定了的显示订单、机器、保障", async (ctx) => {
    if (!staff || !mine.bound) return ctx.skip();
    const client = createSimulatedWecomClient();
    const profile = await getSidebarProfile(staff, mine.bound, { client });
    expect(profile.bound).toBe(true);
    if (profile.bound) {
      expect(profile.customer.phoneMasked).toMatch(/\*{4}/);
      expect(profile.orders.length).toBeLessThanOrEqual(5);
      // 别人开的单只给摘要（没有单号）
      for (const o of profile.orders) if (o.orderNo === null) expect(o.id).toBeNull();
    }
    if (othersFollow) await expect(getSidebarProfile(staff, othersFollow, { client })).rejects.toThrow("不是你的企业微信好友");
    await expect(getSidebarProfile(staff, "bad id!", { client })).rejects.toThrow("客户 id 不对");
  });

  it("认领：完整手机号对上、两头都没绑过才行；不是自己的好友不行", async (ctx) => {
    if (!staff) return ctx.skip();
    const me = staff;
    const client = createSimulatedWecomClient();
    await inRolledBackTx(async (tx) => {
      const ext = "wmSidebarTest0001";
      await tx.wecomFollow.create({ data: { externalUserid: ext, wecomUserid: me.wecomUserid, userId: me.id, firstAddAt: new Date() } });
      const a = await tx.customer.create({ data: { name: "侧边栏甲", phone: "19900001111" } });
      const b = await tx.customer.create({ data: { name: "侧边栏乙", phone: "19900002222", wecomExternalUserid: "wmSomebodyElse01" } });
      await expect(claimFromSidebar(me, ext, "1990000", { client, db: tx })).rejects.toThrow("11 位手机号");
      await expect(claimFromSidebar(me, ext, "19900009999", { client, db: tx })).rejects.toThrow("没有这个手机号");
      await expect(claimFromSidebar(me, ext, b.phone, { client, db: tx })).rejects.toThrow("已经绑了别的微信");
      await expect(claimFromSidebar(me, "wmNotMyFriend01", a.phone, { client, db: tx })).rejects.toThrow("不是你的企业微信好友");

      expect(await claimFromSidebar(me, ext, "199 0000 1111", { client, db: tx })).toEqual({ id: a.id, name: "侧边栏甲" });
      const bound = await tx.customer.findUniqueOrThrow({ where: { id: a.id } });
      expect(bound).toMatchObject({ wecomExternalUserid: ext, wecomNickname: "微信用户0001" });
      expect((await tx.wecomFollow.findFirstOrThrow({ where: { externalUserid: ext } })).customerId).toBe(a.id);
      expect(await tx.auditLog.count({ where: { action: "wecom.claim", entityId: String(a.id) } })).toBe(1);

      const c = await tx.customer.create({ data: { name: "侧边栏丙", phone: "19900003333" } });
      await expect(claimFromSidebar(me, ext, c.phone, { client, db: tx })).rejects.toThrow("这个微信已经绑了别的客户");
      await expect(claimFromSidebar(me, ext, a.phone, { client, db: tx })).rejects.toThrow("已经绑定在这个客户上了");
    });
  });
});
