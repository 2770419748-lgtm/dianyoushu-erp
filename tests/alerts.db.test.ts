import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { runAlerts, templateWriter, type DigestWriter } from "@/server/alerts/alert-service";
import { formatDate } from "@/lib/format";
import type { PushResult } from "@/server/alerts/push";

// 智能提醒（口径第 18 节，连本机库，事务回滚不留数据）：在一家新建的测试门店里造几件要处理的事，跑规则 →
// 命中的提醒、今日待办、发给本店店长店员的消息、推门店群；再跑一遍内容没变不重复推；处理掉一件再跑，提醒消失、消息重新标未读。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let base: { regionId: number; deviceSkuId: number; accessorySkuId: number } | null = null;

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 60000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

beforeAll(async () => {
  try {
    const [region, device, accessory] = await Promise.all([
      prisma.region.findFirst({ where: { isActive: true }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, isService: false, model: { category: { kind: "ACCESSORY" } } }, orderBy: { id: "asc" } }),
    ]);
    if (region && device && accessory) base = { regionId: region.id, deviceSkuId: device.id, accessorySkuId: accessory.id };
  } catch {
    base = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 3600 * 1000;

describe("智能提醒（连本机库，事务回滚）", () => {
  it("测试门店：命中规则 → 今日待办 → 本店消息 → 推群；内容不变不重推；处理掉一件再跑会更新", async (ctx) => {
    if (!base) return ctx.skip();
    const b = base;
    await inRolledBackTx(async (tx) => {
      const now = new Date();
      const store = await tx.store.create({ data: { code: "ZT-AL1", name: "提醒测试店", regionId: b.regionId, wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key-123456" } });
      const manager = await tx.user.create({ data: { username: "altest_m", passwordHash: "x", name: "提醒测试店长", role: "STORE_MANAGER", storeId: store.id } });
      await tx.user.create({ data: { username: "altest_s", passwordHash: "x", name: "提醒测试店员", role: "STAFF", storeId: store.id } });
      await tx.device.create({ data: { code: "ALTEST0000000001", skuId: b.deviceSkuId, storeId: store.id, status: "IN_STOCK", costFen: 100000, createdAt: new Date(now.getTime() - 45 * DAY) } });
      await tx.device.create({ data: { code: "ALTEST0000000002", skuId: b.deviceSkuId, storeId: store.id, status: "RECYCLED", costFen: 50000, createdAt: new Date(now.getTime() - 10 * DAY) } });
      const stocktake = await tx.stocktake.create({ data: { stocktakeNo: "ST-ALTEST-1", storeId: store.id, createdById: manager.id, createdAt: new Date(now.getTime() - 3 * DAY) } });
      await tx.sku.update({ where: { id: b.accessorySkuId }, data: { safetyQty: 5 } });
      await tx.accessoryStock.create({ data: { storeId: store.id, skuId: b.accessorySkuId, qty: 1 } });

      const pushes: string[] = [];
      const push = async (url: string | null, md: string): Promise<PushResult> => {
        pushes.push(md);
        return url ? { status: "SENT" } : { status: "NONE" };
      };
      const r1 = await runAlerts({ db: tx, now, storeIds: [store.id], writer: templateWriter, push });
      const kinds = (await tx.alertItem.findMany({ where: { scopeKey: `store:${store.id}` } })).map((i) => i.kind).sort();
      expect(kinds).toEqual(["LOW_ACCESSORY", "STALE_DEVICES", "STOCKTAKE_OPEN", "TRADE_IN_IDLE"]);
      expect(r1.digests).toBe(2); // 店长版、店员版（这家店没有 KPI、日结，两份一样）
      const digest = await tx.alertDigest.findFirstOrThrow({ where: { scopeKey: `store:${store.id}` } });
      const staffDigest = await tx.alertDigest.findFirstOrThrow({ where: { scopeKey: `store-staff:${store.id}` } });
      expect(digest).toMatchObject({ source: "TEMPLATE", itemCount: 4, pushStatus: null });
      expect(staffDigest).toMatchObject({ itemCount: 4, pushStatus: "SENT", content: digest.content }); // 门店群推店员版
      expect(digest.content).toContain("提醒测试店 今日待办");
      expect(pushes).toHaveLength(1);
      expect(await tx.notification.findMany({ where: { digestId: digest.id }, select: { userId: true } })).toEqual([{ userId: manager.id }]);
      expect(await tx.notification.count({ where: { digestId: staffDigest.id } })).toBe(1);
      await tx.notification.updateMany({ where: { digestId: { in: [digest.id, staffDigest.id] } }, data: { readAt: now } });

      // 再跑一遍：内容没变，不重推，已读的还是已读
      await runAlerts({ db: tx, now, storeIds: [store.id], writer: templateWriter, push });
      expect(pushes).toHaveLength(1);
      expect(await tx.notification.count({ where: { digestId: { in: [digest.id, staffDigest.id] }, readAt: null } })).toBe(0);

      // 盘点确认了：这条提醒消失，待办内容变了 → 重新标未读、再推一次
      await tx.stocktake.update({ where: { id: stocktake.id }, data: { status: "CONFIRMED", confirmedById: manager.id, confirmedAt: now } });
      await runAlerts({ db: tx, now, storeIds: [store.id], writer: templateWriter, push });
      expect(await tx.alertItem.count({ where: { scopeKey: `store:${store.id}`, kind: "STOCKTAKE_OPEN" } })).toBe(0);
      expect(pushes).toHaveLength(2);
      expect(await tx.notification.count({ where: { digestId: { in: [digest.id, staffDigest.id] }, readAt: null } })).toBe(2);
      expect((await tx.alertDigest.findUniqueOrThrow({ where: { id: digest.id } })).itemCount).toBe(3);
    });
  });

  it("日结按收款方式分别看：现金多 500、微信少 500 合计 0 也提醒；店员版不放日结", async (ctx) => {
    if (!base) return ctx.skip();
    const b = base;
    await inRolledBackTx(async (tx) => {
      const now = new Date();
      const yesterday = new Date(new Date(formatDate(now)).getTime() - DAY);
      const store = await tx.store.create({ data: { code: "ZT-AL3", name: "提醒测试三店", regionId: b.regionId } });
      const manager = await tx.user.create({ data: { username: "altest_m3", passwordHash: "x", name: "提醒测试店长三", role: "STORE_MANAGER", storeId: store.id } });
      await tx.user.create({ data: { username: "altest_s3", passwordHash: "x", name: "提醒测试店员三", role: "STAFF", storeId: store.id } });
      await tx.device.create({ data: { code: "ALTEST0000000004", skuId: b.deviceSkuId, storeId: store.id, status: "IN_STOCK", costFen: 100000, createdAt: new Date(now.getTime() - 45 * DAY) } });
      await tx.salesOrder.create({ data: { orderNo: "SO-ALTEST-3", storeId: store.id, salespersonId: manager.id, bizDate: yesterday, subtotalFen: 0, totalFen: 0 } });
      const close = await tx.dailyClose.create({ data: { closeNo: "DC-ALTEST-3", storeId: store.id, bizDate: yesterday, status: "CONFIRMED" } });
      await tx.dailyCloseLine.createMany({
        data: [
          { dailyCloseId: close.id, method: "CASH", systemFen: 100000, actualFen: 150000, diffFen: 50000 },
          { dailyCloseId: close.id, method: "WECHAT", systemFen: 100000, actualFen: 50000, diffFen: -50000 },
        ],
      });
      await runAlerts({ db: tx, now, storeIds: [store.id], writer: templateWriter, push: async () => ({ status: "NONE" }) });
      const item = await tx.alertItem.findFirstOrThrow({ where: { scopeKey: `store:${store.id}`, kind: "DAILY_CLOSE" } });
      expect(item.detail).toContain("现金多 500 元、微信少 500 元");
      const staff = await tx.alertDigest.findFirstOrThrow({ where: { scopeKey: `store-staff:${store.id}` } });
      expect(staff.content).not.toContain("日结");
      expect((await tx.alertDigest.findFirstOrThrow({ where: { scopeKey: `store:${store.id}` } })).content).toContain("日结");
    });
  });

  it("店员版不放 KPI；命中的没变就不重写、不重推（模型每次措辞不同、等的天数变了都不算）", async (ctx) => {
    if (!base) return ctx.skip();
    const b = base;
    await inRolledBackTx(async (tx) => {
      const now = new Date();
      const today = formatDate(now);
      const store = await tx.store.create({ data: { code: "ZT-AL2", name: "提醒测试二店", regionId: b.regionId, wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key-654321" } });
      await tx.user.create({ data: { username: "altest_m2", passwordHash: "x", name: "提醒测试店长二", role: "STORE_MANAGER", storeId: store.id } });
      await tx.user.create({ data: { username: "altest_s2", passwordHash: "x", name: "提醒测试店员二", role: "STAFF", storeId: store.id } });
      await tx.device.create({ data: { code: "ALTEST0000000003", skuId: b.deviceSkuId, storeId: store.id, status: "IN_STOCK", costFen: 100000, createdAt: new Date(now.getTime() - 45 * DAY) } });
      const kpiHit = Number(today.slice(8)) >= 2; // 1 号时间进度不到 5%，不算落后
      await tx.kpiTarget.create({ data: { storeId: store.id, year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)), salesTargetFen: 100000000, profitTargetFen: 0, deviceQtyTarget: 0, tradeInQtyTarget: 0 } });
      let n = 0;
      const writer: DigestWriter = async (input) => ({ content: `${input.title}：第 ${++n} 种说法，${input.items.map((i) => i.title).join("、")}`, source: "MODEL", fallbackReason: null });
      const pushes: string[] = [];
      const push = async (_url: string | null, md: string): Promise<PushResult> => {
        pushes.push(md);
        return { status: "SENT" };
      };
      await runAlerts({ db: tx, now, storeIds: [store.id], writer, push });
      const manager = await tx.alertDigest.findFirstOrThrow({ where: { scopeKey: `store:${store.id}` } });
      const staff = await tx.alertDigest.findFirstOrThrow({ where: { scopeKey: `store-staff:${store.id}` } });
      if (kpiHit) {
        expect(manager.content).toContain("KPI 落后");
        expect(staff.content).not.toContain("KPI 落后");
        expect(staff.itemCount).toBe(manager.itemCount - 1);
        expect(n).toBe(2);
      }
      expect(pushes).toEqual([staff.content]);
      // 一小时后再跑：滞销“最久压了几天”没变、模型换了说法也不重写不重推，模型都不用调
      await runAlerts({ db: tx, now: new Date(now.getTime() + 3600 * 1000), storeIds: [store.id], writer, push });
      expect(pushes).toHaveLength(1);
      expect(n).toBe(kpiHit ? 2 : 1);
      expect((await tx.alertDigest.findUniqueOrThrow({ where: { id: staff.id } })).content).toBe(staff.content);
    });
  });

  it("全部跑一遍：门店、区域、总部都有今日待办；区域、总部是门店的汇总", async (ctx) => {
    if (!base) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const report = await runAlerts({ db: tx, writer: templateWriter, push: async () => ({ status: "NONE" }) });
      expect(report.items).toBeGreaterThan(0);
      const scopes = await tx.alertDigest.groupBy({ by: ["scope"], _count: { _all: true } });
      expect(scopes.map((s) => s.scope).sort()).toEqual(["HQ", "REGION", "STORE"]);
      const hq = await tx.alertDigest.findFirstOrThrow({ where: { scopeKey: "hq" } });
      expect(hq.content).toContain("家店");
      const hqUsers = await tx.user.count({ where: { role: "HQ", isActive: true } });
      expect(await tx.notification.count({ where: { digestId: hq.id } })).toBe(hqUsers);
    });
  });
});
