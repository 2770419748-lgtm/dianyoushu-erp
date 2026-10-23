import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { checkDataKeys } from "@/server/pii/key-check";
import type { CurrentUser } from "@/server/auth/current-user";
import { searchCustomers } from "@/server/customers/customer-service";
import { decryptPii } from "@/server/pii/crypto";

// 个人信息加密（口径第 20 节，连本机演示数据，只读）：库里没有明文手机号；客户能按整号、尾号 4 位找到，中间几位找不到。

const select = { id: true, username: true, name: true, role: true, storeId: true, regionId: true, isActive: true, store: { select: { id: true, name: true, regionId: true } }, region: { select: { id: true, name: true } } } as const;
let hq: CurrentUser | null = null;

beforeAll(async () => {
  try {
    hq = (await prisma.user.findFirst({ where: { username: "hq" }, select })) as unknown as CurrentUser | null;
  } catch {
    hq = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

class Rollback extends Error {}
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

describe("个人信息钥匙核对（连本机库，事务回滚）", () => {
  it("现在的钥匙对得上；核对记录被换成别的钥匙写的、或老库客户的指纹对不上，都报对不上", async (ctx) => {
    if (!hq) return ctx.skip();
    expect(await checkDataKeys(prisma)).toMatchObject({ ok: true });
    await inRolledBackTx(async (tx) => {
      await tx.systemSetting.update({ where: { key: "data_key_check" }, data: { value: { enc: "v1.AAAA.BBBB.CCCC", fp: "别的钥匙" } } });
      const r = await checkDataKeys(tx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("和写这个库时用的不一样");
    });
    await inRolledBackTx(async (tx) => {
      // 老库：没有核对记录，拿第一个客户核对
      await tx.systemSetting.delete({ where: { key: "data_key_check" } });
      const first = await tx.customer.findFirstOrThrow({ orderBy: { id: "asc" } });
      await tx.customer.update({ where: { id: first.id }, data: { phoneFp: "换过钥匙算出来的" } });
      expect((await checkDataKeys(tx)).ok).toBe(false);
      expect(await tx.systemSetting.count({ where: { key: "data_key_check" } })).toBe(0); // 对不上不补记录
    });
    await inRolledBackTx(async (tx) => {
      // 老库客户对得上：补一条核对记录
      await tx.systemSetting.delete({ where: { key: "data_key_check" } });
      expect(await checkDataKeys(tx)).toEqual({ ok: true, created: true });
      expect(await tx.systemSetting.count({ where: { key: "data_key_check" } })).toBe(1);
    });
  });
});

describe("手机号加密存（连本机库，只读）", () => {
  it("库里客户、运营商业务、员工档案、发票接收方都没有明文号码", async (ctx) => {
    if (!hq) return ctx.skip();
    // 任何一列里出现一串 11 位手机号都算漏了（打码号码中间是 *，密文是 base64url 分段）
    const leaks = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT (
        (SELECT COUNT(*) FROM customers WHERE phone_enc ~ '1[3-9]\\d{9}' OR phone_masked ~ '\\d{11}')
        + (SELECT COUNT(*) FROM carrier_business WHERE phone_enc ~ '1[3-9]\\d{9}' OR phone_masked ~ '\\d{11}')
        + (SELECT COUNT(*) FROM employee_profiles WHERE phone_masked ~ '\\d{11}')
        + (SELECT COUNT(*) FROM invoices WHERE receiver_enc NOT LIKE 'v1.%')
      )::bigint AS n`;
    expect(Number(leaks[0]!.n)).toBe(0);
  });

  it("整号、尾号 4 位能搜到客户，中间几位搜不到", async (ctx) => {
    if (!hq) return ctx.skip();
    const c = await prisma.customer.findFirst({ orderBy: { id: "asc" }, select: { id: true, phoneEnc: true } });
    if (!c) return ctx.skip();
    const phone = decryptPii(c.phoneEnc);
    expect((await searchCustomers(hq, phone)).rows.map((r) => r.id)).toEqual([c.id]); // 全公司唯一
    const tail = await searchCustomers(hq, phone.slice(-4));
    expect(tail.total).toBeGreaterThan(0);
    expect(tail.rows.every((r) => r.phoneMasked.endsWith(phone.slice(-4)))).toBe(true);
    const middle = await searchCustomers(hq, phone.slice(3, 8)); // 5 位中间数字：不按号码搜，只会按姓名搜（姓名里没有数字）
    expect(middle.total).toBe(0);
  });
});
