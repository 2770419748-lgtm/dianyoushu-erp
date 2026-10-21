import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { createSimulatedWecomClient, type KfInboundMessage, type WecomClient } from "@/server/wecom/client";
import { cleanupKfMessages, handleKfMessage, onKfMsgOrEvent } from "@/server/wecom/kf-service";
import { simulateKfMessage, SIMULATED_KF_ID } from "@/server/wecom/simulator";

// 微信客服（口径第 12 节第三步，连本机库，事务回滚不留数据）：去重、认意图答复、转人工后不再自动答、
// 会话结束恢复、48 小时外不发、我的保障只答绑定过的、游标存库、180 天清理、演示的模拟发消息。

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
    const u = await prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } });
    if (u) hq = { id: u.id, username: u.username, name: u.name, role: u.role, storeId: u.storeId, regionId: u.regionId, isActive: u.isActive, store: null, region: null };
  } catch {
    hq = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 记下发了什么、转了几次人工的模拟客户端 */
function recordingClient() {
  const sent: string[] = [];
  let transfers = 0;
  const base = createSimulatedWecomClient();
  const client: WecomClient = {
    ...base,
    async sendKfText(input) {
      sent.push(input.text);
      return base.sendKfText(input);
    },
    async transferKfToHuman() {
      transfers++;
    },
  };
  return { client, sent, transfers: () => transfers };
}

let seq = 0;
function msg(externalUserid: string, text: string | null, extra: Partial<KfInboundMessage> = {}): KfInboundMessage {
  seq++;
  return { msgid: `test-kf-${Date.now()}-${seq}`, openKfid: "wkTest01", externalUserid, sendTime: new Date(), origin: 3, msgType: "text", text, event: null, ...extra };
}

describe("微信客服（连本机库，事务回滚）", () => {
  it("答复、去重、转人工后不再自动答、会话结束恢复、48 小时外不发", async (ctx) => {
    if (!hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const { client, sent, transfers } = recordingClient();
      const c = { db: tx, client, now: new Date(), simulated: true };
      const ext = "wmKfTestAnon01";

      const first = msg(ext, "你们几点关门？");
      expect(await handleKfMessage(c, first)).toBe("replied");
      expect(sent.at(-1)).toContain("营业时间");
      expect(await handleKfMessage(c, first)).toBe("duplicate"); // 企业微信重复推同一条
      const session = await tx.wecomKfSession.findUniqueOrThrow({ where: { openKfid_externalUserid: { openKfid: "wkTest01", externalUserid: ext } } });
      expect(session).toMatchObject({ state: "AUTO", outSinceIn: 1, customerId: null });

      // 没绑定档案的问“我的保障”：不答、转人工
      expect(await handleKfMessage(c, msg(ext, "我的碎屏险到什么时候"))).toBe("transferred");
      expect(sent.at(-1)).toContain("核对身份");
      expect(transfers()).toBe(1);
      expect(await handleKfMessage(c, msg(ext, "人呢"))).toBe("human");
      const sentBefore = sent.length;
      expect(await handleKfMessage(c, msg(ext, "保修多久"))).toBe("human");
      expect(sent.length).toBe(sentBefore); // 人工接待中不自动答
      // 接待人员结束会话 → 恢复自动答复
      expect(await handleKfMessage(c, msg(ext, null, { origin: 4, msgType: "event", event: { type: "session_status_change", changeType: 3 } }))).toBe("event");
      expect(await handleKfMessage(c, msg(ext, "保修多久"))).toBe("replied");
      expect(sent.at(-1)).toContain("保修 12 个月");

      // 连着两句没听懂转人工
      const ext2 = "wmKfTestAnon02";
      expect(await handleKfMessage(c, msg(ext2, "在吗"))).toBe("replied");
      expect(sent.at(-1)).toContain("没太明白");
      expect(await handleKfMessage(c, msg(ext2, "哈哈"))).toBe("transferred");
      expect((await tx.wecomKfSession.findFirstOrThrow({ where: { externalUserid: ext2 } })).state).toBe("HUMAN");

      // 客户 3 天前的消息（比如失败重放）：过了 48 小时不发，记下来
      const ext3 = "wmKfTestAnon03";
      const old = msg(ext3, "保修多久", { sendTime: new Date(Date.now() - 3 * 24 * 3600 * 1000) });
      const before = sent.length;
      expect(await handleKfMessage(c, old)).toBe("replied");
      expect(sent.length).toBe(before);
      const unsent = await tx.wecomKfMessage.findFirstOrThrow({ where: { session: { externalUserid: ext3 }, direction: "OUT" } });
      expect(unsent).toMatchObject({ delivered: false, note: expect.stringContaining("48 小时") });
    });
  });

  it("转人工接口报错：先不告诉客户“已转人工”，改说打门店电话，会话还是自动答复，不整批失败", async (ctx) => {
    if (!hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const sent: string[] = [];
      const base = createSimulatedWecomClient();
      const client: WecomClient = {
        ...base,
        async sendKfText(input) {
          sent.push(input.text);
          return base.sendKfText(input);
        },
        async transferKfToHuman() {
          throw new Error("会话状态不允许转接（95016）");
        },
      };
      const c = { db: tx, client, now: new Date(), simulated: true };
      const ext = "wmKfTestFail01";
      expect(await handleKfMessage(c, msg(ext, "我要投诉"))).toBe("replied");
      expect(sent).toEqual([expect.stringContaining("正在帮您转人工"), expect.stringContaining("暂时转不了人工")]); // 先说“正在转”，转不了接着说打门店电话
      expect((await tx.wecomKfSession.findFirstOrThrow({ where: { externalUserid: ext } })).state).toBe("AUTO");
      expect(await tx.wecomKfMessage.count({ where: { session: { externalUserid: ext }, content: "[转人工失败]" } })).toBe(1);
      expect(await handleKfMessage(c, msg(ext, "保修多久"))).toBe("replied"); // 后面的消息照常答
    });
  });

  it("先发“正在转人工”再调接口：转进待接入池以后企业微信不让再用接口发消息，客户也能收到这句", async (ctx) => {
    if (!hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const order: string[] = [];
      let inPool = false;
      const base = createSimulatedWecomClient();
      const client: WecomClient = {
        ...base,
        async sendKfText(input) {
          if (inPool) throw new Error("会话不在智能助手接待状态（95018）"); // 照企业微信的规定写的假接口
          order.push(`发：${input.text}`);
          return base.sendKfText(input);
        },
        async transferKfToHuman() {
          order.push("转人工");
          inPool = true;
        },
      };
      const c = { db: tx, client, now: new Date(), simulated: true };
      expect(await handleKfMessage(c, msg("wmKfTestPool01", "人工"))).toBe("transferred");
      expect(order).toEqual([expect.stringContaining("正在帮您转人工"), "转人工"]);
      inPool = false;
      order.length = 0;
      expect(await handleKfMessage(c, msg("wmKfTestPool02", "我的碎屏险到什么时候"))).toBe("transferred"); // 没绑定档案：先说要核对身份
      expect(order).toEqual([expect.stringContaining("核对身份"), "转人工"]);
    });
  });

  it("我的保障只答绑定过档案的客户；拉消息按游标、存游标", async (ctx) => {
    if (!hq) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const ext = "wmKfTestBound01";
      await tx.customer.create({ data: { name: "客服测试", phone: "19911112222", wecomExternalUserid: ext } });
      const inbox = [msg(ext, "我的碎屏险到什么时候"), msg(ext, "iPhone 16 多少钱")];
      const client = createSimulatedWecomClient({ kfInbox: inbox });
      const note = await onKfMsgOrEvent({ OpenKfId: "wkTest01", Token: "t" }, { db: tx, client, now: new Date(), simulated: true });
      expect(note).toContain("自动答复 2 条");
      const out = await tx.wecomKfMessage.findMany({ where: { session: { externalUserid: ext }, direction: "OUT" }, orderBy: { id: "asc" } });
      expect(out[0]!.content).toContain("您在本店");
      expect((await tx.wecomKfSession.findFirstOrThrow({ where: { externalUserid: ext } })).customerId).not.toBeNull();
      expect((await tx.wecomKfCursor.findUniqueOrThrow({ where: { openKfid: "wkTest01" } })).cursor).toMatch(/^sim-/);
    });
  });

  it("消息留 180 天；演示的模拟发消息只给总部、走完整回调", async (ctx) => {
    if (!hq) return ctx.skip();
    const me = hq;
    await inRolledBackTx(async (tx) => {
      const session = await tx.wecomKfSession.create({ data: { openKfid: "wkTest01", externalUserid: "wmKfTestOld01", updatedAt: new Date(Date.now() - 200 * 24 * 3600 * 1000) } });
      await tx.wecomKfMessage.create({ data: { msgid: "test-kf-old-1", sessionId: session.id, direction: "IN", msgType: "text", content: "很久以前", sentAt: new Date(Date.now() - 200 * 24 * 3600 * 1000) } });
      await tx.$executeRaw`UPDATE wecom_kf_sessions SET updated_at = now() - interval '200 days' WHERE id = ${session.id}`;
      const cleaned = await cleanupKfMessages({ db: tx });
      expect(cleaned.messages).toBeGreaterThanOrEqual(1);
      expect(await tx.wecomKfSession.findUnique({ where: { id: session.id } })).toBeNull();

      const staff = { ...me, role: "STAFF" as const };
      await expect(simulateKfMessage(staff, { persona: "anon", text: "你好" }, { db: tx })).rejects.toThrow("只有总部");
      const result = await simulateKfMessage(me, { persona: "anon", text: "门店地址在哪" }, { db: tx });
      const msgs = await tx.wecomKfMessage.findMany({ where: { sessionId: result.sessionId }, orderBy: { id: "asc" } });
      expect(msgs.map((m) => m.direction)).toEqual(["IN", "OUT"]);
      expect(msgs[0]!.intent).toBe("HOURS");
      expect(await tx.wecomEvent.count({ where: { source: "KF", simulated: true } })).toBeGreaterThanOrEqual(1);
      await expect(simulateKfMessage(me, { externalUserid: "wmNoSuchSession", text: "你好" }, { db: tx })).rejects.toThrow("会话不存在");
      const again = await simulateKfMessage(me, { externalUserid: result.externalUserid, text: "保修多久" }, { db: tx });
      expect(again.sessionId).toBe(result.sessionId);
      expect(SIMULATED_KF_ID).toBeTruthy();
    });
  });
});
