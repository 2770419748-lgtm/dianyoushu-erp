import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canTransferWecomCustomer } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { writeAudit } from "@/server/audit";
import { isUniqueViolation } from "@/server/db-errors";
import { lockRow } from "@/server/db-lock";
import { asTx, type Db, getWecomClient, type TransferKindKey, translateWecomError, type WecomClient, WecomError, withTx } from "./client";

// 企业微信客户继承（口径第 12 节第三步）：
// - 在职转接：店长、总部在客户详情里把一个员工的客户转给另一个员工，马上提交企业微信；客户 24 小时内可以拒绝，同一个客户 90 天内最多转 2 次；
// - 离职继承：停用员工马上生效，不等继承；他跟进中的客户生成“等删除成员”的任务，企业微信后台删了这个人才能提交；
// - 结果每天查一次（也能在页面上点“查进度”）：接替完毕就把跟进关系转到接手人名下，原来那条标成“已转走”，客户档案的绑定不变。

export class WecomTransferError extends Error {}

/** 同一个客户 90 天内最多在职转接 2 次（企业微信的规定，系统先按本地记录拦） */
export const TRANSFER_LIMIT_DAYS = 90;
export const TRANSFER_LIMIT_COUNT = 2;

const OPEN: ("WAITING_DELETE" | "SUBMITTED")[] = ["WAITING_DELETE", "SUBMITTED"];

const RESULT_TEXT: Record<number, string> = { 3: "客户拒绝了", 4: "接手人的客户数到上限了", 5: "企业微信没有这次接替的记录" };

function assertCanTransfer(user: CurrentUser) {
  if (!canTransferWecomCustomer(user.role)) throw new WecomTransferError("只有店长和总部能转接企业微信客户");
}

/** 接手人：在职、填了企业微信账号；店长只能交给本店的人 */
async function loadTakeover(db: Db, user: CurrentUser, toUserId: number) {
  const to = await db.user.findUnique({ where: { id: toUserId }, select: { id: true, name: true, isActive: true, storeId: true, wecomUserid: true } });
  if (!to || !to.isActive) throw new WecomTransferError("接手人不存在或已经停用");
  if (!to.wecomUserid) throw new WecomTransferError(`${to.name}还没填企业微信账号`);
  if (user.role === "STORE_MANAGER" && to.storeId !== user.storeId) throw new WecomTransferError("店长只能交给本店的员工");
  return { ...to, wecomUserid: to.wecomUserid };
}

/** 在职转接：客户详情的企业微信区点“转接跟进人” */
export async function transferOnJob(user: CurrentUser, input: { followId: unknown; toUserId: unknown }, options: { db?: Db; client?: WecomClient; now?: Date } = {}) {
  assertCanTransfer(user);
  const followId = Number(input.followId);
  const toUserId = Number(input.toUserId);
  if (!Number.isInteger(followId) || !Number.isInteger(toUserId)) throw new WecomTransferError("选一个接手人");
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  let claimed: { id: number; externalUserid: string; fromWecomUserid: string; toWecomUserid: string; to: string; from: string };
  try {
    claimed = await withTx(db, async (tx) => {
      if (!(await lockRow(tx, "wecom_follows", followId))) throw new WecomTransferError("这条跟进关系不存在");
      const follow = await tx.wecomFollow.findUniqueOrThrow({ where: { id: followId }, include: { user: { select: { id: true, name: true, storeId: true, isActive: true } } } });
      if (follow.status !== "ACTIVE") throw new WecomTransferError("这个客户已经不是好友了，转不了");
      if (user.role === "STORE_MANAGER" && follow.user?.storeId !== user.storeId) throw new WecomTransferError("店长只能转接本店员工跟进的客户");
      if (follow.user && !follow.user.isActive) throw new WecomTransferError("原跟进人已经停用，到客户继承页安排离职继承");
      const to = await loadTakeover(tx, user, toUserId);
      if (to.wecomUserid === follow.wecomUserid) throw new WecomTransferError("接手人就是现在的跟进人");
      const already = await tx.wecomFollow.findUnique({ where: { externalUserid_wecomUserid: { externalUserid: follow.externalUserid, wecomUserid: to.wecomUserid } } });
      if (already?.status === "ACTIVE") throw new WecomTransferError(`${to.name}已经是这个客户的企业微信好友了`);
      if (await tx.wecomTransfer.findFirst({ where: { followId, status: { in: OPEN } } })) throw new WecomTransferError("这个客户正在转接中，等结果出来再说");
      const since = new Date(now.getTime() - TRANSFER_LIMIT_DAYS * 24 * 3600 * 1000);
      const recent = await tx.wecomTransfer.count({ where: { externalUserid: follow.externalUserid, kind: "ON_JOB", status: { in: ["SUBMITTED", "DONE"] }, createdAt: { gte: since } } });
      if (recent >= TRANSFER_LIMIT_COUNT) throw new WecomTransferError(`这个客户 ${TRANSFER_LIMIT_DAYS} 天内已经转过 ${TRANSFER_LIMIT_COUNT} 次了（企业微信的规定）`);

      const row = await tx.wecomTransfer.create({
        data: { kind: "ON_JOB", followId, externalUserid: follow.externalUserid, customerId: follow.customerId, fromUserId: follow.userId, fromWecomUserid: follow.wecomUserid, toUserId: to.id, toWecomUserid: to.wecomUserid, status: "SUBMITTED", createdById: user.id, submittedAt: now },
      });
      return { id: row.id, externalUserid: follow.externalUserid, fromWecomUserid: follow.wecomUserid, toWecomUserid: to.wecomUserid, to: to.name, from: follow.user?.name ?? follow.wecomUserid };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new WecomTransferError("这个客户正在转接中，等结果出来再说");
    throw error;
  }
  // 事务外调企业微信（单次最多几秒，不占着数据库的锁）
  const client = options.client ?? getWecomClient();
  let failure: string | null = null;
  try {
    const codes = await client.transferCustomers({ kind: "ON_JOB", handoverUserid: claimed.fromWecomUserid, takeoverUserid: claimed.toWecomUserid, externalUserids: [claimed.externalUserid] });
    const code = codes[claimed.externalUserid] ?? -1;
    if (code !== 0) failure = translateWecomError(code, "");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure) {
    await db.wecomTransfer.updateMany({ where: { id: claimed.id, status: "SUBMITTED" }, data: { status: "FAILED", finishedAt: new Date(), error: `企业微信没接受：${failure}`.slice(0, 300) } });
    throw new WecomTransferError(`企业微信没接受这次转接：${failure}`);
  }
  await writeAudit({ userId: user.id, action: "wecom.transfer.on_job", entity: "wecom_transfer", entityId: claimed.id, detail: { externalUserid: claimed.externalUserid, from: claimed.from, to: claimed.to, mode: client.mode } }, asTx(db));
  return { id: claimed.id, to: claimed.to };
}

/** 员工重新启用了：他还在“等删除成员”的离职继承任务没意义了，取消掉（2026-10-21 复查后补） */
export async function cancelResignedTransfersFor(db: Db, userId: number, reason: string) {
  return db.wecomTransfer.updateMany({ where: { fromUserId: userId, status: "WAITING_DELETE" }, data: { status: "FAILED", finishedAt: new Date(), error: reason } });
}

/** 客户继承页“取消”：还没提交的离职继承（店长本店、总部） */
export async function cancelTransfer(user: CurrentUser, id: number, db: Db = prisma) {
  assertCanTransfer(user);
  const t = await db.wecomTransfer.findUnique({ where: { id }, include: { fromUser: { select: { storeId: true } } } });
  if (!t) throw new WecomTransferError("这条继承不存在");
  if (user.role === "STORE_MANAGER" && t.fromUser?.storeId !== user.storeId) throw new WecomTransferError("店长只能取消本店员工的");
  const changed = await db.wecomTransfer.updateMany({ where: { id, status: "WAITING_DELETE" }, data: { status: "FAILED", finishedAt: new Date(), error: `${user.name}手工取消` } });
  if (changed.count === 0) throw new WecomTransferError("只有还在“等删除成员”的能取消，已经提交给企业微信的等结果");
  await writeAudit({ userId: user.id, action: "wecom.transfer.cancel", entity: "wecom_transfer", entityId: id, detail: { externalUserid: t.externalUserid } }, asTx(db));
}

/**
 * 离职继承：停用员工时（或之后在客户继承页）给他跟进中的客户安排接手人。生成“等删除成员”的任务，
 * 企业微信后台把这个人删掉后由每日任务（或“查进度”）提交。已经有没办完的继承的跟进关系跳过。
 */
export async function createResignedTransfers(user: CurrentUser, input: { fromUserId: unknown; toUserId: unknown }, options: { db?: Db } = {}) {
  assertCanTransfer(user);
  const fromUserId = Number(input.fromUserId);
  const toUserId = Number(input.toUserId);
  if (!Number.isInteger(fromUserId) || !Number.isInteger(toUserId)) throw new WecomTransferError("选一个接手人");
  const db = options.db ?? prisma;
  return withTx(db, async (tx) => {
    const from = await tx.user.findUnique({ where: { id: fromUserId }, select: { id: true, name: true, isActive: true, storeId: true } });
    if (!from) throw new WecomTransferError("员工不存在");
    if (from.isActive) throw new WecomTransferError(`${from.name}还在职，用客户详情里的“转接跟进人”`);
    if (user.role === "STORE_MANAGER" && from.storeId !== user.storeId) throw new WecomTransferError("店长只能安排本店员工的客户");
    const to = await loadTakeover(tx, user, toUserId);
    const follows = await tx.wecomFollow.findMany({ where: { userId: from.id, status: "ACTIVE", transfers: { none: { status: { in: OPEN } } } } });
    const candidates = follows.filter((f) => f.wecomUserid !== to.wecomUserid);
    if (candidates.length === 0) throw new WecomTransferError(`${from.name}没有要交接的企业微信客户`);
    const created = await tx.wecomTransfer.createMany({
      data: candidates.map((f) => ({ kind: "RESIGNED" as const, followId: f.id, externalUserid: f.externalUserid, customerId: f.customerId, fromUserId: from.id, fromWecomUserid: f.wecomUserid, toUserId: to.id, toWecomUserid: to.wecomUserid, status: "WAITING_DELETE" as const, createdById: user.id })),
      skipDuplicates: true, // 并发时同一条跟进关系只留一个（部分唯一索引）
    });
    await writeAudit({ userId: user.id, action: "wecom.transfer.resigned", entity: "user", entityId: from.id, detail: { to: to.name, count: created.count } }, tx);
    return { count: created.count, from: from.name, to: to.name };
  });
}

// ---------- 推进：提交离职继承、查结果 ----------

type TransferRow = Prisma.WecomTransferGetPayload<object>;

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** 接替完毕：原来那条标“已转走”，接手人名下建（或恢复）一条跟进关系，客户档案的绑定不变 */
async function finishDone(db: Db, t: TransferRow, now: Date) {
  await withTx(db, async (tx) => {
    const changed = await tx.wecomTransfer.updateMany({ where: { id: t.id, status: "SUBMITTED" }, data: { status: "DONE", finishedAt: now } });
    if (changed.count === 0) return;
    await tx.wecomFollow.updateMany({ where: { id: t.followId, status: "ACTIVE" }, data: { status: "DELETED", deletedBy: "TRANSFERRED", deletedAt: now } });
    await tx.wecomFollow.upsert({
      where: { externalUserid_wecomUserid: { externalUserid: t.externalUserid, wecomUserid: t.toWecomUserid } },
      create: { externalUserid: t.externalUserid, wecomUserid: t.toWecomUserid, userId: t.toUserId, customerId: t.customerId, state: "transfer", firstAddAt: now },
      update: { status: "ACTIVE", deletedAt: null, deletedBy: null, userId: t.toUserId, customerId: t.customerId ?? undefined },
    });
    await writeAudit({ userId: null, action: "wecom.transfer.done", entity: "wecom_transfer", entityId: t.id, detail: { externalUserid: t.externalUserid, kind: t.kind } }, tx);
  });
}

/** 每日任务和页面上的“查进度”：离职的先看成员删了没、删了就提交；已提交的查结果回写 */
export async function processTransfers(options: { db?: Db; client?: WecomClient; now?: Date; storeId?: number } = {}) {
  const db = options.db ?? prisma;
  const client = options.client ?? getWecomClient();
  const now = options.now ?? new Date();
  const report = { submitted: 0, waitingDelete: 0, done: 0, refused: 0, failed: 0, pending: 0, errors: [] as string[] };
  const scope: Prisma.WecomTransferWhereInput = options.storeId ? { fromUser: { storeId: options.storeId } } : {};

  // 1. 离职继承：等删除成员的
  const waiting = await db.wecomTransfer.findMany({ where: { status: "WAITING_DELETE", ...scope }, orderBy: { id: "asc" }, take: 1000 });
  const deletedCache = new Map<string, boolean>();
  for (const [key, rows] of groupBy(waiting, (t) => `${t.fromWecomUserid}|${t.toWecomUserid}`)) {
    const [from, to] = key.split("|") as [string, string];
    try {
      if (!deletedCache.has(from)) deletedCache.set(from, await client.isMemberDeleted(from));
      if (!deletedCache.get(from)) {
        report.waitingDelete += rows.length;
        continue;
      }
      for (const part of chunks(rows, 100)) {
        // 先占住：条件更新成功的才归这一次提交（另一个同时在跑的“查进度”占不到，就不会重复提交）
        const mine: typeof part = [];
        for (const t of part) {
          const claimedRow = await db.wecomTransfer.updateMany({ where: { id: t.id, status: "WAITING_DELETE" }, data: { status: "SUBMITTED", submittedAt: now } });
          if (claimedRow.count === 1) mine.push(t);
        }
        if (mine.length === 0) continue;
        let codes: Record<string, number>;
        try {
          codes = await client.transferCustomers({ kind: "RESIGNED", handoverUserid: from, takeoverUserid: to, externalUserids: mine.map((t) => t.externalUserid) });
        } catch (error) {
          // 整批没提交上：放回“等删除成员”，下次再试
          await db.wecomTransfer.updateMany({ where: { id: { in: mine.map((t) => t.id) }, status: "SUBMITTED" }, data: { status: "WAITING_DELETE", submittedAt: null } });
          throw error;
        }
        for (const t of mine) {
          const code = codes[t.externalUserid] ?? -1;
          if (code === 0) report.submitted++;
          else {
            await db.wecomTransfer.updateMany({ where: { id: t.id, status: "SUBMITTED" }, data: { status: "FAILED", finishedAt: now, error: translateWecomError(code, "") } });
            report.failed++;
          }
        }
      }
    } catch (error) {
      report.errors.push(`${from}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2. 已提交的：查结果
  const submitted = await db.wecomTransfer.findMany({ where: { status: "SUBMITTED", ...scope }, orderBy: { id: "asc" }, take: 2000 });
  for (const [key, rows] of groupBy(submitted, (t) => `${t.kind}|${t.fromWecomUserid}|${t.toWecomUserid}`)) {
    const [kind, from, to] = key.split("|") as [TransferKindKey, string, string];
    try {
      const results = await client.getTransferResults({ kind, handoverUserid: from, takeoverUserid: to, externalUserids: rows.map((t) => t.externalUserid) });
      for (const t of rows) {
        const status = results[t.externalUserid];
        if (status === 1) {
          await finishDone(db, t, now);
          report.done++;
        } else if (status === 3) {
          await db.wecomTransfer.updateMany({ where: { id: t.id, status: "SUBMITTED" }, data: { status: "REFUSED", finishedAt: now, error: RESULT_TEXT[3] } });
          report.refused++;
        } else if (status === 4 || status === 5) {
          await db.wecomTransfer.updateMany({ where: { id: t.id, status: "SUBMITTED" }, data: { status: "FAILED", finishedAt: now, error: RESULT_TEXT[status] } });
          report.failed++;
        } else {
          report.pending++; // 2 等待接替，或者还查不到
        }
      }
    } catch (error) {
      report.errors.push(`${from} → ${to}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

/** 页面上的“查进度”（店长、总部）：和每日任务做的一样 */
export async function processTransfersNow(user: CurrentUser) {
  assertCanTransfer(user);
  // 店长只处理本店员工的（结果数和本店页面对得上，也不会看到别店的企业微信账号）
  const report = await processTransfers(user.role === "STORE_MANAGER" ? { storeId: user.storeId ?? -1 } : {});
  await writeAudit({ userId: user.id, action: "wecom.transfer.process", detail: report });
  return report;
}

// ---------- 页面 ----------

/** 客户继承页：统计、待安排接手人的离职员工、最近的继承记录、接手人候选 */
export async function getTransferPage(user: CurrentUser) {
  if (!canTransferWecomCustomer(user.role)) throw new PermissionError("客户继承只有店长和总部能看");
  const storeScope: Prisma.WecomTransferWhereInput = user.role === "STORE_MANAGER" ? { fromUser: { storeId: user.storeId } } : {};
  const [rows, counts, pendingUsers, targets] = await Promise.all([
    prisma.wecomTransfer.findMany({
      where: storeScope,
      orderBy: { id: "desc" },
      take: 100,
      include: { customer: { select: { id: true, name: true } }, fromUser: { select: { name: true } }, toUser: { select: { name: true } }, follow: { select: { customer: { select: { wecomNickname: true } } } } },
    }),
    prisma.wecomTransfer.groupBy({ by: ["status"], where: storeScope, _count: { _all: true } }),
    prisma.user.findMany({
      where: { isActive: false, ...(user.role === "STORE_MANAGER" ? { storeId: user.storeId } : {}), wecomFollows: { some: { status: "ACTIVE", transfers: { none: { status: { in: OPEN } } } } } },
      select: { id: true, name: true, store: { select: { name: true } }, _count: { select: { wecomFollows: { where: { status: "ACTIVE", transfers: { none: { status: { in: OPEN } } } } } } } },
    }),
    transferTargets(user),
  ]);
  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<TransferRow["status"], number>>,
    pendingUsers: pendingUsers.map((u) => ({ id: u.id, name: u.name, store: u.store?.name ?? null, follows: u._count.wecomFollows })),
    rows: rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      customer: t.customer ? { id: t.customer.id, name: t.customer.name } : null,
      externalUserid: t.externalUserid,
      from: t.fromUser?.name ?? t.fromWecomUserid,
      to: t.toUser.name,
      createdAt: t.createdAt,
      submittedAt: t.submittedAt,
      finishedAt: t.finishedAt,
      error: t.error,
    })),
    targets,
  };
}

/** 能当接手人的：在职、填了企业微信账号的店员店长（店长只看本店，总部看全部，总部自己也能接） */
export async function transferTargets(user: CurrentUser) {
  if (!canTransferWecomCustomer(user.role)) return [];
  const users = await prisma.user.findMany({
    where: { isActive: true, wecomUserid: { not: null }, role: { in: user.role === "HQ" ? ["STAFF", "STORE_MANAGER", "HQ"] : ["STAFF", "STORE_MANAGER"] }, ...(user.role === "STORE_MANAGER" ? { storeId: user.storeId } : {}) },
    orderBy: [{ storeId: "asc" }, { id: "asc" }],
    select: { id: true, name: true, store: { select: { name: true } } },
  });
  return users.map((u) => ({ id: u.id, label: u.store ? `${u.name}（${u.store.name}）` : u.name }));
}

export type TransferPage = Awaited<ReturnType<typeof getTransferPage>>;

export { WecomError };
