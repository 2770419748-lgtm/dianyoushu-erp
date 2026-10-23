import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { warrantyEndsOn } from "@/lib/entitlement";
import { formatDate } from "@/lib/format";
import type { CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { getReceiptData, getWarrantyData } from "@/server/print/print-service";

// 小票和保修卡（口径第 23 节，连本机库，只读）：权限和看单一样；保修期和维修判断同一个算法；
// 作废的单不出保修卡、退货的机器不出卡；客户只有姓名和打码手机号。

afterAll(async () => {
  await prisma.$disconnect();
});

const asUser = (u: { id: number; username: string; name: string; role: CurrentUser["role"]; storeId: number | null; regionId: number | null; isActive: boolean }) =>
  ({ ...u, mustChangePassword: false, store: null, region: null }) as unknown as CurrentUser;

async function hq() {
  try {
    const u = await prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } });
    return u ? asUser(u) : null;
  } catch {
    return null;
  }
}

describe("小票", () => {
  it("明细、收款、服务起止、保修到期都在；没有成本和完整手机号", async (ctx) => {
    const user = await hq();
    const order = user
      ? await prisma.salesOrder.findFirst({ where: { status: "COMPLETED", customerId: { not: null }, items: { some: { deviceId: { not: null } } } }, orderBy: { id: "desc" }, include: { payments: true, items: true } })
      : null;
    if (!user || !order) return ctx.skip();
    const r = (await getReceiptData(user, order.id))!;
    expect(r.orderNo).toBe(order.orderNo);
    expect(r.totalFen).toBe(order.totalFen);
    expect(r.payments.reduce((s, p) => s + p.amountFen, 0)).toBe(order.payments.reduce((s, p) => s + p.amountFen, 0));
    expect(r.lines).toHaveLength(order.items.length);
    expect(r.warrantyUntil).toBe(formatDate(warrantyEndsOn(order.bizDate)));
    expect(r.customer!.phoneMasked).toMatch(/^\d{3}\*{4}\d{4}$/);
    expect(JSON.stringify(r)).not.toMatch(/costFen|phoneEnc/);
    expect(r.header.title.length).toBeGreaterThan(0);
  });

  it("店员只能打自己开的单（和看单一样）", async (ctx) => {
    const order = await prisma.salesOrder.findFirst({ orderBy: { id: "desc" }, select: { id: true, storeId: true, salespersonId: true } });
    const other = order ? await prisma.user.findFirst({ where: { role: "STAFF", isActive: true, storeId: order.storeId, id: { not: order.salespersonId } } }) : null;
    if (!order || !other) return ctx.skip();
    await expect(getReceiptData(asUser(other), order.id)).rejects.toThrow(PermissionError);
  });
});

describe("保修卡", () => {
  it("一台机器一张，写全串号和保这台机器的服务", async (ctx) => {
    const user = await hq();
    const item = user
      ? await prisma.serviceEntitlement.findFirst({ where: { deviceId: { not: null }, status: "ACTIVE", deviceReturnedAt: null, salesOrder: { status: "COMPLETED" } }, orderBy: { id: "desc" }, select: { salesOrderId: true, device: { select: { code: true } } } })
      : null;
    if (!user || !item) return ctx.skip();
    const w = (await getWarrantyData(user, item.salesOrderId))!;
    expect(w.voided).toBe(false);
    const card = w.cards.find((c) => c.codes.some((code) => code.value === item.device!.code));
    expect(card).toBeDefined();
    expect(card!.services.length).toBeGreaterThan(0);
  });

  it("作废的单、退了货的机器不出卡", async (ctx) => {
    const user = await hq();
    if (!user) return ctx.skip();
    const voided = await prisma.salesOrder.findFirst({ where: { status: "VOIDED", items: { some: { deviceId: { not: null } } } }, select: { id: true } });
    if (voided) expect((await getWarrantyData(user, voided.id))!.cards).toEqual([]);
    const returned = await prisma.salesOrderItem.findFirst({ where: { deviceId: { not: null }, returnedQty: { gt: 0 }, order: { status: "COMPLETED" } }, select: { orderId: true, device: { select: { code: true } } } });
    if (returned) {
      const w = (await getWarrantyData(user, returned.orderId))!;
      expect(w.cards.some((c) => c.codes.some((code) => code.value === returned.device!.code))).toBe(false);
    }
    if (!voided && !returned) ctx.skip();
  });
});
