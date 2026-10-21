import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { canSeeWecomFollow, canSell, canTransferWecomCustomer } from "@/server/auth/permissions";
import { assertStoreAccess, PermissionError } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { asTx, type Db, getWecomClient, type WecomClient, WecomError, withTx } from "./client";
import { BIND_CODE_DAYS, wecomMode } from "./config";

// 客户联系（口径第 12 节）：开单绑定码 + 活码、加好友绑定客户、删好友。
// 企业微信拿不到客户手机号，所以不按手机号自动匹配：只认开单时生成的一次性绑定码（活码的 state），扫哪张单的码就绑哪个客户。

export class WecomContactError extends Error {}

type Fields = Record<string, string>;

// ---------- 开单绑定码 ----------

/** 8 位小写字母数字（去掉容易看错的 0 o 1 l），前面加 o 表示开单：state 最多 30 个字符，够用 */
export function newBindCode(): string {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  return `o${Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("")}`;
}

async function loadOrderForBinding(user: CurrentUser, salesOrderId: number, db: Db) {
  const order = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      store: { select: { id: true, name: true, regionId: true } },
      customer: { select: { id: true, name: true, wecomExternalUserid: true, wecomNickname: true, wecomBoundAt: true } },
      salesperson: { select: { id: true, name: true, wecomUserid: true } },
    },
  });
  if (!order) throw new WecomContactError("销售单不存在");
  try {
    assertStoreAccess(user, order.store);
  } catch (error) {
    if (error instanceof PermissionError) throw new WecomContactError(error.message);
    throw error;
  }
  if (user.role === "STAFF" && order.salespersonId !== user.id) throw new WecomContactError("店员只能给自己开的单生成二维码");
  return order;
}

/** 销售单详情页的“加企业微信”卡片 */
export async function getOrderWecomCard(user: CurrentUser, salesOrderId: number, db: Db = prisma) {
  const mode = wecomMode();
  if (mode === "off") return null;
  const order = await loadOrderForBinding(user, salesOrderId, db);
  const now = new Date();
  const code = await db.wecomBindCode.findFirst({ where: { salesOrderId, usedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
  return {
    mode,
    canCreate: canSell(user.role) && order.status === "COMPLETED" && order.customer !== null && !order.customer.wecomExternalUserid,
    customer: order.customer ? { name: order.customer.name, bound: order.customer.wecomExternalUserid !== null, nickname: order.customer.wecomNickname, boundAt: order.customer.wecomBoundAt } : null,
    salesperson: { name: order.salesperson.name, hasWecom: order.salesperson.wecomUserid !== null },
    code: code ? { code: code.code, qrCodeUrl: code.qrCodeUrl, expiresAt: code.expiresAt } : null,
  };
}

export type OrderWecomCard = NonNullable<Awaited<ReturnType<typeof getOrderWecomCard>>>;

/**
 * 开单后店员点“生成加企业微信二维码”：建一个一次性绑定码，再在企业微信建一个只给开单人的“联系我”活码（state = 绑定码）。
 * 同一张单已经有没用、没过期的码就直接用它，不重复建。散客单、已经加过企业微信的客户不建。
 */
export async function createOrderBindCode(user: CurrentUser, salesOrderId: number, options: { db?: Db; client?: WecomClient; now?: Date } = {}) {
  if (!canSell(user.role)) throw new WecomContactError("你的角色不能给客户生成二维码");
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const order = await loadOrderForBinding(user, salesOrderId, db);
  if (order.status !== "COMPLETED") throw new WecomContactError("作废的单不能生成二维码");
  if (!order.customer) throw new WecomContactError("散客单没有客户档案，先补客户再生成（客户的企业微信要绑到档案上）");
  if (order.customer.wecomExternalUserid) throw new WecomContactError("这个客户已经加过企业微信了");
  const existing = await db.wecomBindCode.findFirst({ where: { salesOrderId, usedAt: null, expiresAt: { gt: now } } });
  if (existing) return existing;
  if (!order.salesperson.wecomUserid) throw new WecomContactError(`开单人${order.salesperson.name}还没填企业微信账号，先在组织管理里填上`);

  const client = options.client ?? getWecomClient();
  const code = newBindCode();
  const way = await client.createOrderContactWay({ userid: order.salesperson.wecomUserid, state: code, remark: `销售单 ${order.orderNo}` });
  let row;
  try {
    row = await db.wecomBindCode.create({
      data: {
        code,
        customerId: order.customer.id,
        salesOrderId,
        storeId: order.storeId,
        userId: order.salespersonId,
        configId: way.configId,
        qrCodeUrl: way.qrCodeUrl,
        expiresAt: new Date(now.getTime() + BIND_CODE_DAYS * 24 * 3600 * 1000),
      },
    });
  } catch (error) {
    // 企业微信那边的活码已经建了、库里没记上：补删一次，不然库里没有它，每日清理也找不到
    await client.deleteContactWay(way.configId).catch(() => undefined);
    throw error;
  }
  await writeAudit({ userId: user.id, action: "wecom.contact_way.create", entity: "sales_order", entityId: salesOrderId, detail: { code, mode: client.mode } }, asTx(db));
  return row;
}

/** 每日脚本：过期没用的绑定码，删掉企业微信那边的活码配置（企业微信对“联系我”有数量上限） */
export async function cleanupExpiredBindCodes(options: { db?: Db; client?: WecomClient; now?: Date } = {}) {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const client = options.client ?? getWecomClient();
  const expired = await db.wecomBindCode.findMany({ where: { usedAt: null, expiresAt: { lte: now }, contactWayDeletedAt: null, configId: { not: null } }, take: 500 });
  let deleted = 0;
  const failed: string[] = [];
  for (const code of expired) {
    try {
      await client.deleteContactWay(code.configId!);
      await db.wecomBindCode.update({ where: { code: code.code }, data: { contactWayDeletedAt: now } });
      deleted++;
    } catch (error) {
      failed.push(`${code.code}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { deleted, failed };
}

// ---------- 回调事件处理 ----------

export interface HandlerContext {
  db: Db;
  client: WecomClient;
  now: Date;
  simulated: boolean;
}

function welcomeText(staffName: string | null, storeName: string | null, bound: boolean): string {
  const who = `${storeName ?? "店有数"}的${staffName ?? "店员"}`;
  return bound
    ? `您好，我是${who}。您在本店买的手机已经登记好了，保修和碎屏险、延保快到期时我会提前提醒您，有问题随时在这里找我。`
    : `您好，我是${who}，以后买手机、修手机有问题随时在这里找我。`;
}

/** 按绑定码绑定客户：码要存在、没用过、没过期；“占用”绑定码和写客户档案在一个事务里 */
async function bindByCode(ctx: HandlerContext, code: string, externalUserid: string) {
  return withTx(ctx.db, async (tx) => {
    const row = await tx.wecomBindCode.findUnique({ where: { code } });
    if (!row) return { ok: false as const, reason: "不是开单绑定码" };
    if (row.usedAt) return { ok: false as const, reason: "绑定码已经用过" };
    if (row.expiresAt <= ctx.now) return { ok: false as const, reason: "绑定码过期了" };
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: row.customerId }, select: { id: true, wecomExternalUserid: true } });
    if (customer.wecomExternalUserid && customer.wecomExternalUserid !== externalUserid) return { ok: false as const, reason: "这个客户已经绑了别的微信" };
    // 条件写入：两次回调同时到，只有一次能“占用”这个码
    const claimed = await tx.wecomBindCode.updateMany({ where: { code, usedAt: null }, data: { usedAt: ctx.now } });
    if (claimed.count === 0) return { ok: false as const, reason: "绑定码已经用过" };
    await tx.customer.update({ where: { id: customer.id }, data: { wecomExternalUserid: externalUserid, wecomBoundAt: ctx.now } });
    await writeAudit({ userId: null, action: "wecom.bind", entity: "customer", entityId: customer.id, detail: { externalUserid, code, simulated: ctx.simulated } }, tx);
    return { ok: true as const, customerId: customer.id, code: row };
  });
}

/**
 * 加好友（add_external_contact）。顺序按审查结论：落跟进关系 → 按绑定码绑定客户 → 立刻发欢迎语（welcome_code 只有 20 秒）；
 * 补昵称头像、删活码这些放在后面，失败了也不影响前面的结果。
 */
export async function onAddExternalContact(fields: Fields, ctx: HandlerContext): Promise<string> {
  const userid = fields.UserID ?? "";
  const externalUserid = fields.ExternalUserID ?? "";
  if (!userid || !externalUserid) throw new Error("事件里缺 UserID 或 ExternalUserID");
  const state = fields.State || null;
  const addedAt = fields.CreateTime ? new Date(Number(fields.CreateTime) * 1000) : ctx.now;
  const staff = await ctx.db.user.findUnique({ where: { wecomUserid: userid }, select: { id: true, name: true, store: { select: { name: true } } } });

  // 1. 跟进关系（重复的事件只会更新同一行）
  await ctx.db.wecomFollow.upsert({
    where: { externalUserid_wecomUserid: { externalUserid, wecomUserid: userid } },
    create: { externalUserid, wecomUserid: userid, userId: staff?.id ?? null, state, firstAddAt: addedAt },
    update: { status: "ACTIVE", deletedAt: null, deletedBy: null, userId: staff?.id ?? undefined, state: state ?? undefined },
  });

  // 2. 绑定客户：这个微信以前绑过就直接挂上；否则看 state 是不是开单绑定码
  let customerId = (await ctx.db.customer.findUnique({ where: { wecomExternalUserid: externalUserid }, select: { id: true } }))?.id ?? null;
  let bindNote = customerId ? "老客户，之前已经绑定" : "没有绑定码，等员工认领";
  let usedCode: { code: string; configId: string | null } | null = null;
  if (!customerId && state) {
    const result = await bindByCode(ctx, state, externalUserid);
    if (result.ok) {
      customerId = result.customerId;
      usedCode = result.code;
      bindNote = "按开单绑定码绑定";
    } else {
      bindNote = result.reason;
    }
  }
  // 这个微信和别的店员原有的好友关系也一起认这个客户（解绑后重新扫码绑上时，原来那几条是空的），和侧边栏认领一样
  if (customerId) await ctx.db.wecomFollow.updateMany({ where: { externalUserid, OR: [{ customerId: null }, { customerId: { not: customerId } }] }, data: { customerId } });

  // 3. 欢迎语
  let welcomeNote = "没有 welcome_code（企业微信后台给这个员工配了欢迎语时不会给）";
  if (fields.WelcomeCode) {
    try {
      await ctx.client.sendWelcomeMessage(fields.WelcomeCode, welcomeText(staff?.name ?? null, staff?.store?.name ?? null, customerId !== null));
      welcomeNote = ctx.client.mode === "simulated" ? "已发（模拟）" : "已发";
    } catch (error) {
      welcomeNote = `没发出：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // 4. 后面的事：补微信昵称头像、删掉用过的活码配置
  if (usedCode && customerId) {
    try {
      const contact = await ctx.client.getExternalContact(externalUserid);
      await ctx.db.customer.update({ where: { id: customerId }, data: { wecomNickname: contact.name || null, wecomAvatarUrl: contact.avatar } });
    } catch {
      // 昵称拿不到不影响绑定，下次全量同步再补
    }
    if (usedCode.configId) {
      try {
        await ctx.client.deleteContactWay(usedCode.configId);
        await ctx.db.wecomBindCode.update({ where: { code: usedCode.code }, data: { contactWayDeletedAt: ctx.now } });
      } catch {
        // 删不掉留给每日脚本
      }
    }
  }
  return `跟进人 ${staff?.name ?? userid}；${bindNote}；欢迎语${welcomeNote}`;
}

/** 删好友：del_external_contact 是员工删了客户，del_follow_user 是客户删了员工，两个都要处理 */
export async function onDeleteFollow(fields: Fields, by: "EMPLOYEE" | "CUSTOMER", ctx: HandlerContext): Promise<string> {
  const changed = await ctx.db.wecomFollow.updateMany({
    where: { externalUserid: fields.ExternalUserID ?? "", wecomUserid: fields.UserID ?? "", status: "ACTIVE" },
    data: { status: "DELETED", deletedBy: by, deletedAt: ctx.now },
  });
  return changed.count > 0 ? (by === "EMPLOYEE" ? "员工删了客户" : "客户删了员工") : "没有这条跟进关系，忽略";
}

// ---------- 客户详情里的企业微信区 ----------

/** 客户的企业微信信息：跟进关系按口径第 12 节过滤（员工本人、本店店长、区域经理辖区、总部全部），标签只给看得到跟进关系的人 */
export async function getCustomerWecom(user: CurrentUser, customerId: number) {
  if (wecomMode() === "off") return null;
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { wecomExternalUserid: true, wecomNickname: true, wecomBoundAt: true } });
  if (!customer) return null;
  const follows = await prisma.wecomFollow.findMany({
    where: { customerId },
    orderBy: { firstAddAt: "asc" },
    include: {
      user: { select: { id: true, name: true, isActive: true, store: { select: { id: true, name: true, regionId: true } } } },
      transfers: { where: { status: { in: ["WAITING_DELETE", "SUBMITTED"] } }, select: { status: true, toUser: { select: { name: true } } } },
    },
  });
  const visible = follows.filter((f) => canSeeWecomFollow(user, { userId: f.userId, storeId: f.user?.store?.id ?? null, regionId: f.user?.store?.regionId ?? null }));
  const showTags = user.role === "HQ" || visible.length > 0;
  const tags = showTags
    ? await prisma.wecomCustomerTag.findMany({ where: { customerId }, include: { tag: { select: { groupName: true, name: true } } }, orderBy: { tagId: "asc" } })
    : [];
  return {
    bound: customer.wecomExternalUserid ? { nickname: customer.wecomNickname, boundAt: customer.wecomBoundAt } : null,
    // 绑错了能解绑（口径第 12 节第三步，2026-10-21 复查后补）：总部；店长要这个微信加的是本店员工
    canUnbind: customer.wecomExternalUserid !== null && (user.role === "HQ" || (user.role === "STORE_MANAGER" && follows.some((f) => f.user?.store?.id === user.storeId))),
    follows: visible.map((f) => {
      const open = f.transfers[0] ?? null;
      // 能不能“转接跟进人”（口径第 12 节第三步）：店长转本店在职员工的，总部任意；正在转接的不能再转
      const canTransfer = canTransferWecomCustomer(user.role) && f.status === "ACTIVE" && !open && f.user !== null && f.user.isActive && (user.role === "HQ" || f.user.store?.id === user.storeId);
      return { id: f.id, staffId: f.userId, staff: f.user?.name ?? f.wecomUserid, store: f.user?.store?.name ?? null, status: f.status, deletedBy: f.deletedBy, firstAddAt: f.firstAddAt, deletedAt: f.deletedAt, canTransfer, transferring: open ? { status: open.status, to: open.toUser.name } : null };
    }),
    hiddenFollows: follows.length - visible.length,
    tags: tags.map((t) => ({ group: t.tag.groupName, name: t.tag.name, source: t.source })),
  };
}

export type CustomerWecom = NonNullable<Awaited<ReturnType<typeof getCustomerWecom>>>;

/**
 * 解绑客户档案和微信（认领绑错了、客户报错了号）：要写原因、记日志。解绑后这个微信的好友关系、客服会话都不再算这个客户，
 * 客服问“我的保障”按没绑定处理（转人工）；客户本人的微信可以重新绑。
 */
export async function unbindCustomerWecom(user: CurrentUser, customerId: number, reason: unknown, db: Db = prisma) {
  const why = typeof reason === "string" ? reason.trim().slice(0, 100) : "";
  if (!why) throw new WecomContactError("写一下为什么解绑（比如认领时手机号输错了）");
  if (user.role !== "HQ" && user.role !== "STORE_MANAGER") throw new WecomContactError("只有店长和总部能解绑");
  return withTx(db, async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, wecomExternalUserid: true } });
    if (!customer?.wecomExternalUserid) throw new WecomContactError("这个客户没有绑定微信");
    const ext = customer.wecomExternalUserid;
    if (user.role === "STORE_MANAGER") {
      const mine = await tx.wecomFollow.count({ where: { externalUserid: ext, user: { storeId: user.storeId } } });
      if (mine === 0) throw new WecomContactError("这个微信加的不是本店员工，找总部解绑");
    }
    await tx.customer.update({ where: { id: customerId }, data: { wecomExternalUserid: null, wecomNickname: null, wecomAvatarUrl: null, wecomBoundAt: null } });
    await tx.wecomFollow.updateMany({ where: { externalUserid: ext }, data: { customerId: null } });
    await tx.wecomKfSession.updateMany({ where: { externalUserid: ext }, data: { customerId: null } });
    // 还没办完的客户继承也不再认这个客户（接替完毕时按那时绑的客户写）
    await tx.wecomTransfer.updateMany({ where: { externalUserid: ext, status: { in: ["WAITING_DELETE", "SUBMITTED"] } }, data: { customerId: null } });
    await writeAudit({ userId: user.id, action: "wecom.unbind", entity: "customer", entityId: customerId, detail: { externalUserid: ext, reason: why } }, tx);
  });
}

export { WecomError };
