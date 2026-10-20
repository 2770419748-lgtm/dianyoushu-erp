import "server-only";
import { prisma } from "@/lib/prisma";
import { daysUntil, warrantyEndsOn } from "@/lib/entitlement";
import type { CurrentUser } from "@/server/auth/current-user";
import { findSessionUser } from "@/server/auth/session-user";
import { writeAudit } from "@/server/audit";
import { CustomerError, getCustomerDetail } from "@/server/customers/customer-service";
import { isUniqueViolation } from "@/server/db-errors";
import { todayBizDate } from "@/server/stock/doc-no";
import { type Db, getWecomClient, type WecomClient, withTx } from "./client";
import { EXTERNAL_USERID_PATTERN } from "./config";
import { getCustomerWecom } from "./contact-service";
import { SIDEBAR_TTL_MS, signSidebarToken, verifySidebarToken } from "./sidebar-token";

// 企微聊天侧边栏（口径第 12 节第三步）：员工在企业微信里和客户聊天时，从工具栏打开，看这个客户的订单、机器、保障；
// 还没绑定档案的好友可以按完整手机号认领。登录用侧边栏自己的票（sidebar-token.ts），和 ERP 登录互不相认。

export class SidebarError extends Error {}

export type SidebarUser = CurrentUser & { wecomUserid: string };

/** 侧边栏的票换成员工：票有效、账号在职、会话版本号对得上、企业微信账号没改过 */
export async function sidebarUserFromToken(token: string | undefined): Promise<SidebarUser | null> {
  const payload = await verifySidebarToken(token);
  if (!payload) return null;
  const user = await findSessionUser({ userId: payload.userId, sv: payload.sv });
  if (!user) return null;
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { wecomUserid: true } });
  if (!row?.wecomUserid || row.wecomUserid !== payload.wecomUserid) return null;
  return { ...user, wecomUserid: row.wecomUserid };
}

/** 给一个员工发侧边栏的票：在职、填了企业微信账号才发 */
export async function issueSidebarToken(where: { id: number } | { wecomUserid: string }) {
  const user = await prisma.user.findUnique({ where, select: { id: true, isActive: true, sessionVersion: true, wecomUserid: true } });
  if (!user || !user.isActive) throw new SidebarError("ERP 里没有这个在职员工");
  if (!user.wecomUserid) throw new SidebarError("你还没在 ERP 里填企业微信账号，找总部在组织管理里填上");
  const expiresAt = new Date(Date.now() + SIDEBAR_TTL_MS);
  return { token: await signSidebarToken({ userId: user.id, sv: user.sessionVersion, wecomUserid: user.wecomUserid }, expiresAt), expiresAt };
}

/** 浏览器传上来的客户 id 不可信：格式对、而且这个员工和这个客户是企业微信好友、还在跟进，才往下查 */
async function assertMyContact(db: Db, user: SidebarUser, externalUserid: string) {
  if (!EXTERNAL_USERID_PATTERN.test(externalUserid)) throw new SidebarError("客户 id 不对");
  const follow = await db.wecomFollow.findUnique({ where: { externalUserid_wecomUserid: { externalUserid, wecomUserid: user.wecomUserid } } });
  if (!follow || follow.status !== "ACTIVE") throw new SidebarError("这个客户不是你的企业微信好友（或者已经删了好友），看不了");
  return follow;
}

/** 客户买过、还没退的机器和保修到期日 */
async function customerDevices(customerId: number) {
  const today = todayBizDate();
  const items = await prisma.salesOrderItem.findMany({
    where: { order: { customerId, status: "COMPLETED" }, deviceId: { not: null }, returnedQty: 0 },
    orderBy: { id: "desc" },
    take: 10,
    select: { id: true, sku: { select: { name: true } }, device: { select: { code: true } }, order: { select: { bizDate: true, store: { select: { name: true } } } } },
  });
  return items.map((i) => {
    const warrantyEnds = warrantyEndsOn(i.order.bizDate);
    return { key: i.id, name: i.sku.name, code: i.device?.code ?? "", boughtOn: i.order.bizDate, store: i.order.store.name, warrantyEnds, warrantyDaysLeft: daysUntil(warrantyEnds, today) };
  });
}

/** 侧边栏要显示的：绑定了档案的显示订单、机器、保障、标签；没绑定的显示认领入口 */
export async function getSidebarProfile(user: SidebarUser, externalUserid: string, options: { client?: WecomClient } = {}) {
  await assertMyContact(prisma, user, externalUserid);
  const customer = await prisma.customer.findUnique({ where: { wecomExternalUserid: externalUserid }, select: { id: true, wecomNickname: true } });
  if (!customer) {
    let nickname: string | null = null;
    try {
      nickname = (await (options.client ?? getWecomClient()).getExternalContact(externalUserid)).name || null;
    } catch {
      // 昵称拿不到不影响认领
    }
    return { bound: false as const, nickname, staff: user.name };
  }
  let detail;
  try {
    detail = await getCustomerDetail(user, customer.id);
  } catch (error) {
    if (error instanceof CustomerError) throw new SidebarError(error.message);
    throw error;
  }
  if (!detail) throw new SidebarError("客户档案不存在");
  const [wecom, devices] = await Promise.all([getCustomerWecom(user, customer.id), customerDevices(customer.id)]);
  return {
    bound: true as const,
    nickname: customer.wecomNickname,
    staff: user.name,
    customer: detail.customer,
    orders: detail.orders.slice(0, 5),
    orderCount: detail.orderCount,
    entitlements: detail.entitlements,
    devices,
    tags: wecom?.tags ?? [],
    follows: (wecom?.follows ?? []).filter((f) => f.status === "ACTIVE").map((f) => ({ staff: f.staff, store: f.store })),
  };
}

export type SidebarProfile = Awaited<ReturnType<typeof getSidebarProfile>>;

/**
 * 认领：员工问客户要完整手机号，把这个企业微信好友绑到客户档案上。手机号要完全对上；
 * 这个客户已经绑了别的微信、这个微信已经绑了别的客户都不行（两头都有唯一约束兜底）。
 */
export async function claimFromSidebar(user: SidebarUser, externalUserid: unknown, phone: unknown, options: { client?: WecomClient; now?: Date; db?: Db } = {}) {
  const db = options.db ?? prisma;
  const id = typeof externalUserid === "string" ? externalUserid : "";
  await assertMyContact(db, user, id);
  const mobile = typeof phone === "string" ? phone.replace(/\s/g, "") : "";
  if (!/^1\d{10}$/.test(mobile)) throw new SidebarError("填客户完整的 11 位手机号");
  const now = options.now ?? new Date();
  let result: { id: number; name: string };
  try {
    result = await withTx(db, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { phone: mobile }, select: { id: true, name: true, wecomExternalUserid: true } });
      if (!customer) throw new SidebarError("没有这个手机号的客户档案（开单时会自动建档）");
      if (customer.wecomExternalUserid === id) throw new SidebarError("已经绑定在这个客户上了");
      if (customer.wecomExternalUserid) throw new SidebarError("这个客户已经绑了别的微信，核对一下手机号");
      const other = await tx.customer.findUnique({ where: { wecomExternalUserid: id }, select: { id: true } });
      if (other) throw new SidebarError("这个微信已经绑了别的客户");
      const changed = await tx.customer.updateMany({ where: { id: customer.id, wecomExternalUserid: null }, data: { wecomExternalUserid: id, wecomBoundAt: now } });
      if (changed.count === 0) throw new SidebarError("这个客户刚被别人绑定了，刷新看一下");
      await tx.wecomFollow.updateMany({ where: { externalUserid: id }, data: { customerId: customer.id } });
      await writeAudit({ userId: user.id, action: "wecom.claim", entity: "customer", entityId: customer.id, detail: { externalUserid: id, via: "sidebar" } }, tx);
      return { id: customer.id, name: customer.name };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new SidebarError("这个微信刚被绑到别的客户上了，刷新看一下");
    throw error;
  }
  try {
    const contact = await (options.client ?? getWecomClient()).getExternalContact(id);
    await db.customer.update({ where: { id: result.id }, data: { wecomNickname: contact.name || null, wecomAvatarUrl: contact.avatar } });
  } catch {
    // 昵称头像拿不到不影响绑定
  }
  return result;
}

/** 演示页（模拟模式）：我的企业微信好友，左边的“聊天列表” */
export async function listMyContacts(user: CurrentUser) {
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { wecomUserid: true } });
  if (!me?.wecomUserid) return { hasWecom: false as const, contacts: [] };
  const follows = await prisma.wecomFollow.findMany({
    where: { wecomUserid: me.wecomUserid, status: "ACTIVE" },
    orderBy: [{ customerId: { sort: "asc", nulls: "first" } }, { firstAddAt: "desc" }],
    take: 50,
    include: { customer: { select: { name: true, wecomNickname: true } } },
  });
  return {
    hasWecom: true as const,
    contacts: follows.map((f) => ({ externalUserid: f.externalUserid, name: f.customer?.name ?? null, nickname: f.customer?.wecomNickname ?? null, addedAt: f.firstAddAt })),
  };
}

/** 演示提示（只在模拟模式用）：给没绑定的好友找一个可以认领的客户手机号——自己开过单、还没绑定微信的客户 */
export async function demoClaimHint(user: CurrentUser): Promise<{ name: string; phone: string } | null> {
  const order = await prisma.salesOrder.findFirst({
    where: { status: "COMPLETED", customer: { wecomExternalUserid: null }, ...(user.role === "STAFF" ? { salespersonId: user.id } : user.storeId ? { storeId: user.storeId } : {}) },
    orderBy: { id: "desc" },
    select: { customer: { select: { name: true, phone: true } } },
  });
  return order?.customer ? { name: order.customer.name, phone: order.customer.phone } : null;
}

