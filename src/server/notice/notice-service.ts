import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { clampPage } from "@/lib/paging";
import { canPublishNotice } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { type Db, withTx } from "@/server/db-tx";
import { isDbId } from "@/lib/paging";

// 公告（口径第 19 节）：总部发全部、区域、门店，店长发本店。发布时给范围内在职的人发系统内消息（小铃铛），
// 打开详情算已读；发布人和总部看已读人数；撤下了大家都看不到（不删）。

export class NoticeError extends Error {}

export const NOTICE_PAGE_SIZE = 20;

/** 我能看的公告：发给全部的、发给我所在区域的、发给我所在门店的；总部全部；自己发的 */
function visibleWhere(user: CurrentUser): Prisma.NoticeWhereInput {
  if (user.role === "HQ") return {};
  const regionId = user.role === "REGIONAL_MANAGER" ? user.regionId : (user.store?.regionId ?? null);
  return {
    OR: [
      { scope: "ALL" },
      ...(regionId ? [{ scope: "REGION" as const, regionId }] : []),
      ...(user.storeId ? [{ scope: "STORE" as const, storeId: user.storeId }] : []),
      { authorId: user.id },
    ],
  };
}

/** 这个人在不在这条公告的发送范围里（按他现在在哪家店、哪个区域算；发布人自己不算） */
function isRecipient(user: CurrentUser, notice: { scope: "ALL" | "REGION" | "STORE"; regionId: number | null; storeId: number | null; authorId: number }): boolean {
  if (notice.authorId === user.id) return false;
  if (notice.scope === "ALL") return true;
  if (notice.scope === "STORE") return user.storeId !== null && user.storeId === notice.storeId;
  const regionId = user.role === "REGIONAL_MANAGER" ? user.regionId : (user.store?.regionId ?? null);
  return regionId !== null && regionId === notice.regionId;
}

/** 发给哪些人：范围内在职的人 */
async function recipientsOf(db: Db, scope: "ALL" | "REGION" | "STORE", regionId: number | null, storeId: number | null) {
  const where: Prisma.UserWhereInput = scope === "ALL" ? {} : scope === "REGION" ? { OR: [{ regionId }, { store: { regionId: regionId ?? -1 } }] } : { storeId };
  return db.user.findMany({ where: { ...where, isActive: true }, select: { id: true } });
}

export async function publishNotice(user: CurrentUser, input: { title: unknown; body: unknown; scope?: unknown; regionId?: unknown; storeId?: unknown }, db: Db = prisma) {
  if (!canPublishNotice(user.role)) throw new NoticeError("公告只有总部和店长能发");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!title || title.length > 60) throw new NoticeError("标题写 1～60 个字");
  if (!body || body.length > 3000) throw new NoticeError("内容写 1～3000 个字");
  let scope: "ALL" | "REGION" | "STORE";
  let regionId: number | null = null;
  let storeId: number | null = null;
  if (user.role === "STORE_MANAGER") {
    if (!user.storeId) throw new NoticeError("你还没分配门店");
    scope = "STORE";
    storeId = user.storeId; // 店长只能发本店
  } else {
    if (input.scope !== undefined && input.scope !== "ALL" && input.scope !== "REGION" && input.scope !== "STORE") throw new NoticeError("发给谁不对（全公司、区域或门店）");
    scope = input.scope ?? "ALL";
    if (scope === "REGION") {
      regionId = Number(input.regionId);
      if (!isDbId(regionId) || !(await db.region.findFirst({ where: { id: regionId, isActive: true } }))) throw new NoticeError("选一个在用的区域");
    }
    if (scope === "STORE") {
      storeId = Number(input.storeId);
      if (!isDbId(storeId) || !(await db.store.findFirst({ where: { id: storeId, isActive: true } }))) throw new NoticeError("选一家在营业的门店");
    }
  }
  return withTx(db, async (tx) => {
    const users = (await recipientsOf(tx, scope, regionId, storeId)).filter((u) => u.id !== user.id); // 发给的人不算发布人自己
    const notice = await tx.notice.create({ data: { title, body, scope, regionId, storeId, authorId: user.id, recipients: users.length } });
    await tx.notification.createMany({
      data: users.map((u) => ({ userId: u.id, noticeId: notice.id, title: `公告：${title}`, body: body.replace(/\s+/g, " ").slice(0, 60), link: `/notices/${notice.id}` })),
      skipDuplicates: true,
    });
    await writeAudit({ userId: user.id, action: "notice.publish", entity: "notice", entityId: notice.id, detail: { title, scope, regionId, storeId, recipients: users.length } }, tx);
    return { id: notice.id, recipients: users.length };
  });
}

export async function withdrawNotice(user: CurrentUser, id: number, db: Db = prisma) {
  const notice = await db.notice.findUnique({ where: { id } });
  if (!notice || notice.withdrawnAt) throw new NoticeError("公告不存在或已经撤下了");
  if (notice.authorId !== user.id && user.role !== "HQ") throw new NoticeError("只有发布人和总部能撤下");
  await withTx(db, async (tx) => {
    await tx.notice.update({ where: { id }, data: { withdrawnAt: new Date() } });
    await tx.notification.deleteMany({ where: { noticeId: id } }); // 小铃铛里的也撤掉
    await writeAudit({ userId: user.id, action: "notice.withdraw", entity: "notice", entityId: id, detail: { title: notice.title } }, tx);
  });
}

export async function listNotices(user: CurrentUser, query: { page?: number }) {
  const page = clampPage(query.page);
  const where: Prisma.NoticeWhereInput = { AND: [visibleWhere(user), user.role === "HQ" ? {} : { OR: [{ withdrawnAt: null }, { authorId: user.id }] }] };
  const [rows, total] = await Promise.all([
    prisma.notice.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * NOTICE_PAGE_SIZE,
      take: NOTICE_PAGE_SIZE,
      include: { author: { select: { name: true } }, reads: { where: { userId: user.id }, select: { readAt: true } }, _count: { select: { reads: true } } },
    }),
    prisma.notice.count({ where }),
  ]);
  const [regions, stores] = await Promise.all([prisma.region.findMany({ select: { id: true, name: true } }), prisma.store.findMany({ select: { id: true, code: true, name: true } })]);
  return {
    total,
    page,
    pageSize: NOTICE_PAGE_SIZE,
    canPublish: canPublishNotice(user.role),
    publishScopes: user.role === "HQ" ? { regions: regions.map((r) => ({ id: r.id, name: r.name })), stores: stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` })) } : null,
    rows: rows.map((n) => ({
      id: n.id,
      title: n.title,
      scope: n.scope,
      scopeLabel: n.scope === "ALL" ? "全公司" : n.scope === "REGION" ? (regions.find((r) => r.id === n.regionId)?.name ?? "区域") : (stores.find((s) => s.id === n.storeId)?.name ?? "门店"),
      author: n.author.name,
      createdAt: n.createdAt,
      withdrawn: n.withdrawnAt !== null,
      read: n.reads.length > 0 || n.authorId === user.id,
      readCount: n.authorId === user.id || user.role === "HQ" ? n._count.reads : null,
      recipients: n.recipients,
    })),
  };
}

export type NoticeList = Awaited<ReturnType<typeof listNotices>>;

/** 打开详情：算已读（小铃铛那条也标已读）；发布人和总部多看谁还没读 */
export async function getNotice(user: CurrentUser, id: number, db: Db = prisma) {
  const notice = await db.notice.findFirst({ where: { AND: [{ id }, visibleWhere(user)] }, include: { author: { select: { name: true } } } });
  if (!notice) return null;
  if (notice.withdrawnAt && notice.authorId !== user.id && user.role !== "HQ") return null;
  // 只有发送范围里的人打开才算已读（总部打开别人的门店公告不算）；同一个人两个标签页同时打开，已有的跳过，不报错
  if (!notice.withdrawnAt && isRecipient(user, notice)) {
    await db.noticeRead.createMany({ data: [{ noticeId: id, userId: user.id }], skipDuplicates: true });
    await db.notification.updateMany({ where: { noticeId: id, userId: user.id, readAt: null }, data: { readAt: new Date() } });
  }
  const canSeeReads = notice.authorId === user.id || user.role === "HQ";
  let unread: string[] = [];
  let readCount = 0;
  if (canSeeReads) {
    const [reads, recipients] = await Promise.all([db.noticeRead.findMany({ where: { noticeId: id }, select: { userId: true } }), recipientsOf(db, notice.scope, notice.regionId, notice.storeId)]);
    readCount = reads.filter((r) => r.userId !== notice.authorId).length;
    const readIds = new Set(reads.map((r) => r.userId));
    const unreadIds = recipients.map((u) => u.id).filter((uid) => !readIds.has(uid) && uid !== notice.authorId);
    unread = (await db.user.findMany({ where: { id: { in: unreadIds.slice(0, 50) } }, select: { name: true } })).map((u) => u.name);
  }
  return {
    id: notice.id,
    title: notice.title,
    body: notice.body,
    scope: notice.scope,
    author: notice.author.name,
    createdAt: notice.createdAt,
    withdrawn: notice.withdrawnAt !== null,
    canWithdraw: !notice.withdrawnAt && (notice.authorId === user.id || user.role === "HQ"),
    reads: canSeeReads ? { readCount, recipients: notice.recipients, unread } : null,
  };
}

export type NoticeDetail = NonNullable<Awaited<ReturnType<typeof getNotice>>>;

/** 调店、换区域、换角色以后，小铃铛里已经看不到的公告消息删掉（不然点开是 404） */
export async function pruneNoticeNotifications(db: Db, userId: number) {
  const user = await db.user.findUnique({ where: { id: userId }, include: { store: { select: { id: true, name: true, regionId: true } }, region: { select: { id: true, name: true } } } });
  if (!user) return 0;
  const me = user as unknown as CurrentUser;
  const notes = await db.notification.findMany({ where: { userId, noticeId: { not: null } }, select: { id: true, notice: { select: { scope: true, regionId: true, storeId: true, authorId: true } } } });
  const stale = notes.filter((n) => n.notice && me.role !== "HQ" && n.notice.authorId !== userId && !isRecipient(me, n.notice)).map((n) => n.id);
  if (stale.length > 0) await db.notification.deleteMany({ where: { id: { in: stale } } });
  return stale.length;
}

/** 点开一条已经看不到的公告：小铃铛里这条清掉，告诉他不在范围了（返回 true 说明是这种情况） */
export async function dropStaleNotice(userId: number, noticeId: number): Promise<boolean> {
  const removed = await prisma.notification.deleteMany({ where: { userId, noticeId } });
  return removed.count > 0;
}
