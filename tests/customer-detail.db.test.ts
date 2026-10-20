import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { CustomerError, getCustomerDetail } from "@/server/customers/customer-service";
import { listExpiringEntitlements } from "@/server/entitlement/entitlement-service";
import { wecomMode } from "@/server/wecom/config";
import { getCustomerWecom } from "@/server/wecom/contact-service";

// 客户详情和到期名单的可见范围（口径第 12 节，连本机演示数据，只读）：
// 客户全公司共享，别的店、别的店员开的单只给摘要（没有单号和链接）；区域经理不进客户详情；到期名单按门店范围看。

const select = { id: true, username: true, name: true, role: true, storeId: true, regionId: true, isActive: true, store: { select: { id: true, name: true, regionId: true } }, region: { select: { id: true, name: true } } } as const;
let users: Record<"hq" | "regional" | "manager" | "staff", CurrentUser> | null = null;

beforeAll(async () => {
  try {
    const rows = await prisma.user.findMany({ where: { username: { in: ["hq", "regional", "manager", "staff"] } }, select });
    if (rows.length === 4) users = Object.fromEntries(rows.map((r) => [r.username, r as unknown as CurrentUser])) as typeof users;
  } catch {
    users = null;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("客户详情与到期名单（连本机库，只读）", () => {
  it("别的店、别的店员开的单只给摘要；区域经理不进客户详情", async (ctx) => {
    if (!users) return ctx.skip();
    const managerStore = users.manager.storeId!;
    // 找一个在本店和别的店都买过东西的老客户
    const rows = await prisma.$queryRaw<{ id: number }[]>`
      SELECT customer_id AS id FROM sales_orders WHERE customer_id IS NOT NULL
      GROUP BY customer_id HAVING bool_or(store_id = ${managerStore}) AND bool_or(store_id <> ${managerStore}) LIMIT 1`;
    if (rows.length === 0) return ctx.skip();
    const customerId = rows[0]!.id;

    const hqView = (await getCustomerDetail(users.hq, customerId))!;
    expect(hqView.orders.every((o) => o.id !== null && o.orderNo !== null)).toBe(true);
    expect(hqView.customer.phoneMasked).toContain("****");

    const managerView = (await getCustomerDetail(users.manager, customerId))!;
    const own = await prisma.salesOrder.findMany({ where: { customerId, storeId: managerStore }, select: { id: true } });
    const ownIds = new Set(own.map((o) => o.id));
    for (const o of managerView.orders) {
      if (ownIds.has(o.key)) expect(o.id).toBe(o.key);
      else expect([o.id, o.orderNo, o.salesperson]).toEqual([null, null, null]);
    }

    const staffView = (await getCustomerDetail(users.staff, customerId))!;
    const mine = await prisma.salesOrder.findMany({ where: { customerId, salespersonId: users.staff.id }, select: { id: true } });
    const mineIds = new Set(mine.map((o) => o.id));
    expect(staffView.orders.filter((o) => o.id !== null).every((o) => mineIds.has(o.id!))).toBe(true);

    await expect(getCustomerDetail(users.regional, customerId)).rejects.toThrow(CustomerError);
  });

  it("到期名单按门店范围看：店长只看到本店，区域经理只看到辖区", async (ctx) => {
    if (!users) return ctx.skip();
    for (const stage of ["T7", "T30"] as const) {
      const managerRows = (await listExpiringEntitlements(users.manager, { stage })).rows;
      expect(managerRows.every((r) => r.storeId === users!.manager.storeId)).toBe(true);
      const regionStores = await prisma.store.findMany({ where: { regionId: users.regional.regionId! }, select: { id: true } });
      const allowed = new Set(regionStores.map((s) => s.id));
      const regionalData = await listExpiringEntitlements(users.regional, { stage });
      expect(regionalData.rows.every((r) => allowed.has(r.storeId))).toBe(true);
      expect([regionalData.canFollowUp, regionalData.canScan, regionalData.canOpenCustomer]).toEqual([false, false, false]);
      expect(regionalData.rows.every((r) => r.daysLeft >= 0 && r.daysLeft <= 30)).toBe(true);
    }
  });

  it("客户详情的企业微信区：跟进关系按员工本人、本店店长、总部过滤", async (ctx) => {
    if (!users || wecomMode() === "off") return ctx.skip();
    const follow = await prisma.wecomFollow.findFirst({ where: { customerId: { not: null }, user: { storeId: users.manager.storeId } }, select: { customerId: true, userId: true } });
    if (!follow) return ctx.skip();
    const customerId = follow.customerId!;
    const hqView = (await getCustomerWecom(users.hq, customerId))!;
    expect(hqView.hiddenFollows).toBe(0);
    expect(hqView.bound).not.toBeNull();
    const managerView = (await getCustomerWecom(users.manager, customerId))!;
    expect(managerView.follows.length).toBeGreaterThan(0);
    const staffView = (await getCustomerWecom(users.staff, customerId))!;
    const all = await prisma.wecomFollow.findMany({ where: { customerId }, select: { id: true, userId: true } });
    expect(staffView.follows.map((x) => x.id).sort()).toEqual(all.filter((x) => x.userId === users!.staff.id).map((x) => x.id).sort());
    if (staffView.follows.length === 0) expect(staffView.tags).toEqual([]); // 一条都看不到就不给标签
  });
});
