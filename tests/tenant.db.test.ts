import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/current-user";
import { assertStoreQuota, OrgError } from "@/server/org/org-service";
import { getCompany, getPaymentMethods, getSetupDone, getSwitches, markSetupDone, saveCompany, savePaymentMethods, saveSwitches, setLicense, SettingsError } from "@/server/settings/settings-service";
import { createTradeInTx, TradeInError } from "@/server/tradein/trade-in-service";

// 开户、初始化和到期（口径第 21 节，连本机库，事务回滚）：系统设置只有总部能改、改了记日志；
// 门店数上限；回收登记身份证“必填”开关。

class Rollback extends Error {}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
let fixture: { hq: CurrentUser; staff: CurrentUser; storeId: number; deviceSkuId: number } | null = null;

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        // 本机库可能已经存过设置：先清掉，按新开户的样子测
        await tx.systemSetting.deleteMany({ where: { key: { in: ["company", "license", "payment_methods", "switches", "setup"] } } });
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

const asUser = (u: { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean }): CurrentUser =>
  ({ id: u.id, username: u.username, name: u.name, role: u.role, storeId: u.storeId, regionId: u.regionId, mustChangePassword: false, isActive: u.isActive, store: null, region: null }) as CurrentUser;

beforeAll(async () => {
  try {
    const [hq, staff, deviceSku] = await Promise.all([
      prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } }),
      prisma.user.findFirst({ where: { role: "STAFF", isActive: true, storeId: { not: null } }, orderBy: { id: "asc" } }),
      prisma.sku.findFirst({ where: { isActive: true, guidePriceFen: { gt: 0 }, model: { category: { kind: "DEVICE" } } }, orderBy: { id: "asc" } }),
    ]);
    if (hq && staff?.storeId && deviceSku) fixture = { hq: asUser(hq), staff: asUser(staff), storeId: staff.storeId, deviceSkuId: deviceSku.id };
  } catch {
    fixture = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("系统设置", () => {
  it("只有总部能改；小票抬头不填用公司名；改了记操作日志", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      await expect(saveCompany(f.staff, { name: "试点通讯" }, tx)).rejects.toThrow(SettingsError);
      await expect(saveCompany(f.hq, { name: "  " }, tx)).rejects.toThrow(/公司名/);
      await expect(saveCompany(f.hq, { name: "试点通讯", phone: "电话abc" }, tx)).rejects.toThrow(/电话/);
      await saveCompany(f.hq, { name: " 试点通讯 ", phone: "0571-8888 6666" }, tx);
      expect(await getCompany(tx)).toEqual({ name: "试点通讯", receiptTitle: "试点通讯", phone: "0571-8888 6666", address: null });
      const audit = await tx.auditLog.findFirst({ where: { action: "settings.company", userId: f.hq.id }, orderBy: { id: "desc" } });
      expect(audit?.detail).toMatchObject({ name: "试点通讯" });
    });
  });

  it("收款方式至少留一种，只认能手选的几种；没设过就全开", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      expect(await getPaymentMethods(tx)).toEqual(["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER"]);
      await expect(savePaymentMethods(f.hq, [], tx)).rejects.toThrow(/至少/);
      await expect(savePaymentMethods(f.hq, ["TRADE_IN", "SUBSIDY"], tx)).rejects.toThrow(/至少/);
      await savePaymentMethods(f.hq, ["WECHAT", "TRADE_IN", "CASH"], tx);
      expect(await getPaymentMethods(tx)).toEqual(["CASH", "WECHAT"]);
    });
  });

  it("没填公司信息不能标记初始化完成；做完可以重新打开", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      expect(await getSetupDone(tx)).toBe(false);
      await expect(markSetupDone(f.hq, true, tx)).rejects.toThrow(/公司信息/);
      await saveCompany(f.hq, { name: "试点通讯" }, tx);
      await markSetupDone(f.hq, true, tx);
      expect(await getSetupDone(tx)).toBe(true);
      await markSetupDone(f.hq, false, tx);
      expect(await getSetupDone(tx)).toBe(false);
    });
  });
});

describe("门店数上限", () => {
  it("上限到了不能再加门店；不限（试用）、演示模式不管", async (ctx) => {
    if (!fixture) return ctx.skip();
    await inRolledBackTx(async (tx) => {
      const active = await tx.store.count({ where: { isActive: true } });
      await assertStoreQuota(tx, false); // 没开户信息：不按门店数拦（只读另外管）
      await setLicense({ plan: "PAID", startedOn: "2026-10-01", expiresOn: "2027-09-30", storeLimit: active + 1 }, tx);
      await assertStoreQuota(tx, false);
      await setLicense({ plan: "PAID", startedOn: "2026-10-01", expiresOn: "2027-09-30", storeLimit: active }, tx);
      await expect(assertStoreQuota(tx, false)).rejects.toThrow(OrgError);
      await assertStoreQuota(tx, true);
      await setLicense({ plan: "TRIAL", startedOn: "2026-10-01", expiresOn: "2026-10-31", storeLimit: null }, tx);
      await assertStoreQuota(tx, false);
    });
  });
});

describe("回收登记身份证必填开关", () => {
  const base = (f: NonNullable<typeof fixture>, seed: number) => ({ storeId: f.storeId, codesText: String(940000000000000 + seed), skuId: f.deviceSkuId, condition: "9 成新", appraisedFen: 50000 });

  it("默认必填；总部关了以后可以不填，但填了就要两样都填、填对", async (ctx) => {
    if (!fixture) return ctx.skip();
    const f = fixture;
    await inRolledBackTx(async (tx) => {
      expect((await getSwitches(tx)).tradeInIdRequired).toBe(true);
      await expect(createTradeInTx(tx, f.hq, base(f, 1))).rejects.toThrow(TradeInError);
      await expect(saveSwitches(f.staff, { tradeInIdRequired: false }, tx)).rejects.toThrow(SettingsError);
      await saveSwitches(f.hq, { tradeInIdRequired: false }, tx);
      expect((await getSwitches(tx)).tradeInIdRequired).toBe(false);
      const t = await createTradeInTx(tx, f.hq, base(f, 2));
      const row = await tx.tradeInOrder.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.sellerName).toBeNull();
      expect(row.sellerIdEnc).toBeNull();
      await expect(createTradeInTx(tx, f.hq, { ...base(f, 3), sellerName: "只填了名字" })).rejects.toThrow(/身份证号/);
      await expect(createTradeInTx(tx, f.hq, { ...base(f, 4), sellerName: "卖家", sellerIdNo: "110105194912310021" })).rejects.toThrow(TradeInError);
    });
  });
});
