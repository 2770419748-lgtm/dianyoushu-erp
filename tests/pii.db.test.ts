import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
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
