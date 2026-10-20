import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { createSalesOrderTx } from "@/server/sales/sales-service";
import { receiveDevices } from "@/server/stock/stock-service";
import { handleWecomCallback } from "@/server/wecom/callback-service";
import { createRealWecomClient, createSimulatedWecomClient, simulatedNickname, type WecomClient, WecomError } from "@/server/wecom/client";
import { SIMULATED_CALLBACK, wecomMode } from "@/server/wecom/config";
import { cleanupExpiredBindCodes, createOrderBindCode } from "@/server/wecom/contact-service";
import { decryptWecomMessage, encryptWecomMessage, wecomSignature } from "@/server/wecom/crypto";
import { buildEncryptedCallback, contactEventFields, simulateScanBindCode } from "@/server/wecom/simulator";
import { OFFICIAL, OFFICIAL_POST } from "./fixtures/wecom-official";

// 企业微信底座（口径第 12 节，连本机库，事务回滚不留数据）：回调验签、去重、按开单绑定码绑客户、删好友、令牌缓存。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let fixture: { storeId: number; deviceSkuId: number; user: CurrentUser } | null = null;

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

const imei = (seed: number) => String(950000000000000 + seed).padStart(15, "0");

/** 记下调过什么的模拟客户端 */
function recordingClient() {
  const base = createSimulatedWecomClient();
  const calls = { welcome: [] as string[], deleted: [] as string[] };
  const client: WecomClient = {
    ...base,
    async sendWelcomeMessage(code, text) {
      calls.welcome.push(text);
      return base.sendWelcomeMessage(code, text);
    },
    async deleteContactWay(configId) {
      calls.deleted.push(configId);
    },
  };
  return { client, calls };
}

beforeAll(async () => {
  try {
    const [store, deviceSku, hq] = await Promise.all([
      prisma.store.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, guidePriceFen: { gt: 0 }, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
    ]);
    if (store && deviceSku && hq) {
      fixture = { storeId: store.id, deviceSkuId: deviceSku.id, user: { id: hq.id, username: hq.username, name: hq.name, role: hq.role, storeId: hq.storeId, regionId: hq.regionId, isActive: hq.isActive, store: null, region: null } };
    }
  } catch {
    fixture = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 开一张带客户的单，开单人填上企业微信账号，生成绑定码 */
async function orderWithCode(tx: Prisma.TransactionClient, seed: number, client: WecomClient, now = new Date()) {
  const f = fixture!;
  await tx.user.update({ where: { id: f.user.id }, data: { wecomUserid: "zz_test_hq" } });
  const customer = await tx.customer.create({ data: { name: "企微测试", phone: `198${String(seed).padStart(8, "0")}` } });
  const [deviceId] = await receiveDevices(tx, { storeId: f.storeId, skuId: f.deviceSkuId, devices: [{ sn: null, imei1: imei(seed), imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: `RI-WX-${seed}`, operatorId: f.user.id });
  const sale = await createSalesOrderTx(tx, f.user, { storeId: f.storeId, customerId: customer.id, items: [{ deviceId }], paymentMethod: "CASH" });
  const code = await createOrderBindCode(f.user, sale.id, { db: tx, client, now });
  return { customerId: customer.id, salesOrderId: sale.id, code };
}

describe("企业微信回调（连本机库，事务回滚）", () => {
  it("官方示例：URL 验证回明文；时间戳过期、签名不对 403；消息落库，重复投递只算一次", async (ctx) => {
    if (!fixture) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const client = createSimulatedWecomClient();
      const verify = new URLSearchParams({ msg_signature: "5c45ff5e21c57e6ad56bac8758b79b1d9ac89fd3", timestamp: "1409659589", nonce: "263014780", echostr: "P9nAzCzyDtyTWESHep1vC5X9xho/qYX3Zpb4yKa9SKld1DsH3Iyt3tP3zNdtp+4RPcs8TgAE7OaBO+FZXvnaqQ==" });
      const at = (ts: string) => new Date(Number(ts) * 1000);
      expect(await handleWecomCallback({ method: "GET", query: verify, body: "" }, { config: OFFICIAL, client, db: tx, now: at("1409659589") })).toMatchObject({ status: 200, body: "1616140317555161061" });
      expect((await handleWecomCallback({ method: "GET", query: verify, body: "" }, { config: OFFICIAL, client, db: tx })).status).toBe(403); // 现在离 2014 年太远

      const body = `<xml><ToUserName><![CDATA[wx5823bf96d3bd56c7]]></ToUserName><Encrypt><![CDATA[${OFFICIAL_POST.encrypt}]]></Encrypt><AgentID><![CDATA[218]]></AgentID></xml>`;
      const query = new URLSearchParams({ msg_signature: OFFICIAL_POST.signature, timestamp: OFFICIAL_POST.timestamp, nonce: OFFICIAL_POST.nonce });
      const now = at(OFFICIAL_POST.timestamp);
      const before = await tx.wecomEvent.count();
      const forged = new URLSearchParams({ msg_signature: "0".repeat(40), timestamp: OFFICIAL_POST.timestamp, nonce: OFFICIAL_POST.nonce });
      expect((await handleWecomCallback({ method: "POST", query: forged, body }, { config: OFFICIAL, client, db: tx, now })).status).toBe(403);
      expect(await tx.wecomEvent.count()).toBe(before); // 伪造的不落库

      const first = await handleWecomCallback({ method: "POST", query, body }, { config: OFFICIAL, client, db: tx, now });
      expect(first).toMatchObject({ status: 200, body: "success" });
      expect(first.duplicate).toBeUndefined();
      const event = await tx.wecomEvent.findUniqueOrThrow({ where: { id: first.eventId! } });
      expect([event.eventType, event.status]).toEqual(["text", "PROCESSED"]);
      // 企业微信重试：同一段明文重新加密（随机串不同、签名不同）也认得出是同一条
      const again = encryptWecomMessage(OFFICIAL.aesKey, decryptWecomMessage(OFFICIAL.aesKey, OFFICIAL_POST.encrypt, OFFICIAL.receiveId), OFFICIAL.receiveId);
      const retryQuery = new URLSearchParams({ msg_signature: wecomSignature(OFFICIAL.token, OFFICIAL_POST.timestamp, "42", again), timestamp: OFFICIAL_POST.timestamp, nonce: "42" });
      const retry = await handleWecomCallback({ method: "POST", query: retryQuery, body: `<xml><Encrypt><![CDATA[${again}]]></Encrypt></xml>` }, { config: OFFICIAL, client, db: tx, now });
      expect(retry).toMatchObject({ status: 200, duplicate: true, eventId: first.eventId });
      expect(await tx.wecomEvent.count()).toBe(before + 1);
    });
  });

  it("加好友：按开单绑定码绑到客户、发欢迎语、删掉活码；重复事件不重复处理；码只能用一次；删好友分清谁删谁", async (ctx) => {
    if (!fixture) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const { client, calls } = recordingClient();
      const now = new Date();
      const { customerId, code } = await orderWithCode(tx, 1, client, now);
      expect(code.configId).toBe(`sim-${code.code}`);
      const run = (fields: Record<string, string | number>, request = buildEncryptedCallback(fields, SIMULATED_CALLBACK, now)) =>
        handleWecomCallback(request, { config: SIMULATED_CALLBACK, client, db: tx, now, simulated: true });

      const add = contactEventFields({ changeType: "add_external_contact", userid: "zz_test_hq", externalUserid: "wmTestA", state: code.code, welcomeCode: "w1", config: SIMULATED_CALLBACK, now });
      const request = buildEncryptedCallback(add, SIMULATED_CALLBACK, now);
      const result = await run(add, request);
      expect(result.status).toBe(200);
      expect((await tx.wecomEvent.findUniqueOrThrow({ where: { id: result.eventId! } })).status).toBe("PROCESSED");
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      expect(customer.wecomExternalUserid).toBe("wmTestA");
      expect(customer.wecomNickname).toBe(simulatedNickname("wmTestA"));
      const follow = await tx.wecomFollow.findUniqueOrThrow({ where: { externalUserid_wecomUserid: { externalUserid: "wmTestA", wecomUserid: "zz_test_hq" } } });
      expect([follow.status, follow.customerId, follow.userId, follow.state]).toEqual(["ACTIVE", customerId, fixture!.user.id, code.code]);
      const usedCode = await tx.wecomBindCode.findUniqueOrThrow({ where: { code: code.code } });
      expect(usedCode.usedAt).not.toBeNull();
      expect(usedCode.contactWayDeletedAt).not.toBeNull();
      expect(calls.deleted).toEqual([code.configId]);
      expect(calls.welcome).toHaveLength(1);
      expect(calls.welcome[0]).toContain("保修");
      expect(await tx.auditLog.count({ where: { action: "wecom.bind", entityId: String(customerId) } })).toBe(1);

      // 企业微信重试同一条：不再处理
      expect((await run(add, request)).duplicate).toBe(true);
      expect(calls.welcome).toHaveLength(1);

      // 另一个人扫了同一张码：好友关系照样记，但码已经用过，不绑
      const other = contactEventFields({ changeType: "add_external_contact", userid: "zz_test_hq", externalUserid: "wmTestB", state: code.code, config: SIMULATED_CALLBACK, now });
      const otherResult = await run(other);
      const otherFollow = await tx.wecomFollow.findUniqueOrThrow({ where: { externalUserid_wecomUserid: { externalUserid: "wmTestB", wecomUserid: "zz_test_hq" } } });
      expect(otherFollow.customerId).toBeNull();
      expect(((await tx.wecomEvent.findUniqueOrThrow({ where: { id: otherResult.eventId! } })).payload as Record<string, string>)._result).toContain("用过");

      // 客户删了员工 / 员工删了客户
      await run(contactEventFields({ changeType: "del_follow_user", userid: "zz_test_hq", externalUserid: "wmTestA", config: SIMULATED_CALLBACK, now }));
      await run(contactEventFields({ changeType: "del_external_contact", userid: "zz_test_hq", externalUserid: "wmTestB", config: SIMULATED_CALLBACK, now: new Date(now.getTime() + 1000) }));
      const [a, b] = await Promise.all([
        tx.wecomFollow.findUniqueOrThrow({ where: { externalUserid_wecomUserid: { externalUserid: "wmTestA", wecomUserid: "zz_test_hq" } } }),
        tx.wecomFollow.findUniqueOrThrow({ where: { externalUserid_wecomUserid: { externalUserid: "wmTestB", wecomUserid: "zz_test_hq" } } }),
      ]);
      expect([a.status, a.deletedBy, b.status, b.deletedBy]).toEqual(["DELETED", "CUSTOMER", "DELETED", "EMPLOYEE"]);
      // 删了又加回来：恢复跟进中，客户还是之前绑的那个
      await run(contactEventFields({ changeType: "add_external_contact", userid: "zz_test_hq", externalUserid: "wmTestA", config: SIMULATED_CALLBACK, now: new Date(now.getTime() + 2000) }));
      const back = await tx.wecomFollow.findUniqueOrThrow({ where: { externalUserid_wecomUserid: { externalUserid: "wmTestA", wecomUserid: "zz_test_hq" } } });
      expect([back.status, back.customerId]).toEqual(["ACTIVE", customerId]);
    });
  });

  it("过期的码不绑；每日清理删掉过期码的活码配置；同一张单不重复建码；散客单不能建", async (ctx) => {
    if (!fixture) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const { client, calls } = recordingClient();
      const longAgo = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      const { salesOrderId, code } = await orderWithCode(tx, 2, client, longAgo);
      const now = new Date();
      const add = contactEventFields({ changeType: "add_external_contact", userid: "zz_test_hq", externalUserid: "wmTestC", state: code.code, config: SIMULATED_CALLBACK, now });
      await handleWecomCallback(buildEncryptedCallback(add, SIMULATED_CALLBACK, now), { config: SIMULATED_CALLBACK, client, db: tx, now, simulated: true });
      expect((await tx.wecomFollow.findUniqueOrThrow({ where: { externalUserid_wecomUserid: { externalUserid: "wmTestC", wecomUserid: "zz_test_hq" } } })).customerId).toBeNull();
      const cleanup = await cleanupExpiredBindCodes({ db: tx, client, now });
      expect(cleanup.deleted).toBeGreaterThanOrEqual(1);
      expect(calls.deleted).toContain(code.configId);

      const fresh = await createOrderBindCode(fixture!.user, salesOrderId, { db: tx, client, now });
      expect(await createOrderBindCode(fixture!.user, salesOrderId, { db: tx, client, now })).toMatchObject({ code: fresh.code });

      const [deviceId] = await receiveDevices(tx, { storeId: fixture!.storeId, skuId: fixture!.deviceSkuId, devices: [{ sn: null, imei1: imei(3), imei2: null }], costFen: 1, docType: "PURCHASE_RECEIPT", docNo: "RI-WX-3", operatorId: fixture!.user.id });
      const walkIn = await createSalesOrderTx(tx, fixture!.user, { storeId: fixture!.storeId, items: [{ deviceId }], paymentMethod: "CASH" });
      await expect(createOrderBindCode(fixture!.user, walkIn.id, { db: tx, client, now })).rejects.toThrow(/散客/);
    });
  });

  it("演示里的“模拟扫码加好友”：走同一个回调处理，绑上客户", async (ctx) => {
    if (!fixture || wecomMode() !== "simulated") return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const { client } = recordingClient();
      const { customerId, code } = await orderWithCode(tx, 4, client);
      const result = await simulateScanBindCode(fixture!.user, code.code, { db: tx, client });
      expect(result.status).toBe("PROCESSED");
      expect((await tx.customer.findUniqueOrThrow({ where: { id: customerId } })).wecomExternalUserid).toMatch(/^wmSim/);
      expect(await tx.wecomEvent.count({ where: { simulated: true } })).toBeGreaterThanOrEqual(1);
      await expect(simulateScanBindCode(fixture!.user, code.code, { db: tx, client })).rejects.toThrow(/用过/);
    });
  });
});

describe("企业微信接口封装（真实现 + 假网络，事务回滚）", () => {
  it("令牌落库缓存：只换一次；被判无效时换新的再试一次；快过期时刷新；错误码翻成人话", async (ctx) => {
    if (!fixture) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      let tokens = 0;
      let rejectOnce = true;
      let clock = new Date("2026-10-20T01:00:00Z");
      const transport = async (url: string) => {
        const u = new URL(url);
        const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
        if (u.pathname.endsWith("/gettoken")) {
          if (u.searchParams.get("corpsecret") === "bad") return json({ errcode: 40001, errmsg: "invalid credential" });
          tokens++;
          return json({ errcode: 0, access_token: `T${tokens}`, expires_in: 7200 });
        }
        if (u.pathname.endsWith("/user/get")) {
          if (rejectOnce) {
            rejectOnce = false;
            return json({ errcode: 42001, errmsg: "access_token expired" });
          }
          if (u.searchParams.get("userid") === "nobody") return json({ errcode: 60111, errmsg: "userid not found" });
          return json({ errcode: 0, userid: u.searchParams.get("userid"), name: "张三", token: u.searchParams.get("access_token") });
        }
        return json({ errcode: -1, errmsg: "unknown" });
      };
      const client = createRealWecomClient({ corpId: "ww-test", secret: "s", transport, db: tx, now: () => clock });
      expect(await client.getMember("zhangsan")).toEqual({ userid: "zhangsan", name: "张三" });
      expect(tokens).toBe(2); // 第一次换令牌，被判过期后又换了一次
      await client.getMember("zhangsan");
      expect(tokens).toBe(2); // 缓存里的还能用
      clock = new Date(clock.getTime() + 7200 * 1000 - 60 * 1000); // 离过期不到 5 分钟
      await client.getMember("zhangsan");
      expect(tokens).toBe(3);
      await expect(client.getMember("nobody")).rejects.toThrow(/没有这个账号.*60111/);

      await tx.wecomTokenCache.deleteMany();
      const bad = createRealWecomClient({ corpId: "ww-test", secret: "bad", transport, db: tx, now: () => clock });
      await expect(bad.getMember("zhangsan")).rejects.toThrow(WecomError);
      await expect(bad.getMember("zhangsan")).rejects.toThrow(/Secret/);
    });
  });
});
