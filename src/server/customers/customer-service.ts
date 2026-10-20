import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import { maskPhone } from "@/lib/sales-labels";
import { canSell } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { canAccessStoreSafe } from "@/server/auth/scope";
import { listCustomerEntitlements } from "@/server/entitlement/entitlement-service";

// 客户：按手机号查、新建。手机号在列表和详情里一律脱敏显示；客户不分门店（口径第 8 节）。

export class CustomerError extends Error {}

const PHONE_PATTERN = /^1\d{10}$/;

function assertCanUse(user: CurrentUser): void {
  if (!canSell(user.role)) throw new CustomerError("你的角色不能管理客户");
}

export const CUSTOMER_PAGE_SIZE = 20;

export async function searchCustomers(user: CurrentUser, q = "", page = 1) {
  assertCanUse(user);
  const text = q.trim();
  const current = clampPage(page);
  // 姓名和手机号都能模糊搜（2026-10-17 坤总定：门店常按手机尾号找人）。手机号至少输 4 位数字才按号码匹配，免得输一两位就把全部客户列出来。
  // 已知取舍：能模糊搜手机号，有心人可以一位一位试出被脱敏的中间 4 位；只有店员、店长、总部能搜，演示版接受。
  const where = !text
    ? {}
    : /^\d{4,11}$/.test(text)
      ? { OR: [{ phone: { contains: text } }, { name: { contains: text, mode: "insensitive" as const } }] }
      : { name: { contains: text, mode: "insensitive" as const } };
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (current - 1) * CUSTOMER_PAGE_SIZE,
      take: CUSTOMER_PAGE_SIZE,
      select: { id: true, name: true, phone: true, note: true, createdAt: true, _count: { select: { salesOrders: true } } },
    }),
    prisma.customer.count({ where }),
  ]);
  return {
    rows: rows.map((c) => ({ id: c.id, name: c.name, phoneMasked: maskPhone(c.phone), note: c.note, createdAt: c.createdAt, orders: c._count.salesOrders })),
    total,
    page: current,
    pageSize: CUSTOMER_PAGE_SIZE,
  };
}

export type CustomerRow = Awaited<ReturnType<typeof searchCustomers>>["rows"][number];

export interface CustomerInput {
  name: unknown;
  phone: unknown;
  note?: unknown;
}

function parseCustomer(input: CustomerInput) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CustomerError("请填客户姓名");
  if (name.length > 30) throw new CustomerError("姓名最多 30 个字");
  const phone = typeof input.phone === "string" ? input.phone.replace(/\s+/g, "") : "";
  if (!PHONE_PATTERN.test(phone)) throw new CustomerError("手机号要 11 位，1 开头");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > 200) throw new CustomerError("备注最多 200 个字");
  return { name, phone, note: note || null };
}

export async function createCustomer(user: CurrentUser, input: CustomerInput) {
  assertCanUse(user);
  const data = parseCustomer(input);
  try {
    const customer = await prisma.customer.create({ data });
    await writeAudit({ userId: user.id, action: "customer.create", entity: "customer", entityId: customer.id, detail: { name: data.name, phoneMasked: maskPhone(data.phone) } });
    return { id: customer.id, name: customer.name, phoneMasked: maskPhone(customer.phone) };
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      throw new CustomerError("这个手机号已经有客户了，直接搜出来选");
    }
    throw error;
  }
}

/** 编辑客户：手机号留空表示不改（列表里只有脱敏号，编辑时拿不到原号） */
export async function updateCustomer(user: CurrentUser, id: number, input: CustomerInput) {
  assertCanUse(user);
  const phoneText = typeof input.phone === "string" ? input.phone.trim() : "";
  const current = await prisma.customer.findUnique({ where: { id }, select: { phone: true } });
  if (!current) throw new CustomerError("客户不存在");
  const data = parseCustomer({ ...input, phone: phoneText || current.phone });
  try {
    await prisma.customer.update({ where: { id }, data });
    await writeAudit({ userId: user.id, action: "customer.update", entity: "customer", entityId: id, detail: { name: data.name } });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      throw new CustomerError("这个手机号已经有别的客户了");
    }
    throw error;
  }
}

// ---------- 客户详情 ----------

/** 一张单的商品摘要：第一件的名字 + 一共几件 */
function itemSummary(items: { qty: number; sku: { name: string } }[]): string {
  const count = items.reduce((s, i) => s + i.qty, 0);
  if (items.length === 0) return "-";
  return count > 1 ? `${items[0]!.sku.name} 等 ${count} 件` : items[0]!.sku.name;
}

export const CUSTOMER_ORDER_LIMIT = 30;

/**
 * 客户详情（口径第 12 节）：基本信息、买过的单、碎屏险和延保。客户档案全公司共享，所以别的店、别的店员开的单也会列出来，
 * 但只给日期、门店、商品摘要、金额；自己能打开的单（店员是自己开的，店长是本店的）才带单号和链接。区域经理不进客户详情。
 */
export async function getCustomerDetail(user: CurrentUser, id: number) {
  assertCanUse(user);
  const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true, name: true, phone: true, note: true, createdAt: true } });
  if (!customer) return null;
  const [orders, orderCount, entitlements] = await Promise.all([
    prisma.salesOrder.findMany({
      where: { customerId: id },
      orderBy: [{ bizDate: "desc" }, { id: "desc" }],
      take: CUSTOMER_ORDER_LIMIT,
      include: {
        store: { select: { id: true, code: true, name: true, regionId: true } },
        salesperson: { select: { id: true, name: true } },
        items: { orderBy: { id: "asc" }, select: { qty: true, sku: { select: { name: true } } } },
      },
    }),
    prisma.salesOrder.count({ where: { customerId: id } }),
    listCustomerEntitlements(id),
  ]);
  return {
    customer: { id: customer.id, name: customer.name, phoneMasked: maskPhone(customer.phone), note: customer.note, createdAt: customer.createdAt },
    orders: orders.map((o) => {
      const canOpen = canAccessStoreSafe(user, o.store) && (user.role !== "STAFF" || o.salesperson.id === user.id);
      return {
        key: o.id,
        id: canOpen ? o.id : null,
        orderNo: canOpen ? o.orderNo : null,
        salesperson: canOpen ? o.salesperson.name : null,
        bizDate: o.bizDate,
        store: `${o.store.code} ${o.store.name}`,
        status: o.status,
        totalFen: o.totalFen,
        summary: itemSummary(o.items),
      };
    }),
    orderCount,
    entitlements,
  };
}

export type CustomerDetail = NonNullable<Awaited<ReturnType<typeof getCustomerDetail>>>;
