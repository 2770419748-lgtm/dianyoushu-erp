import "server-only";
import { createHash } from "node:crypto";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { ApprovalStatus } from "@/generated/prisma/enums";
import { APPROVAL_RULE_KINDS, canDecide, nextApprovalStep, OA_ACTIONS, type ApprovalActionKey, type ApprovalRuleKindKey, type ApprovalStepEntry, type ApproverRoleKey } from "@/lib/approval";
import { isValidFen } from "@/lib/limits";
import { canManageApprovalRules } from "@/server/auth/permissions";
import { assertStoreAccess, PermissionError, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { isCheckViolation, isUniqueViolation } from "@/server/db-errors";
import { lockRow } from "@/server/db-lock";
import { type Db, withTx } from "@/server/db-tx";
import { DeviceStateError } from "@/server/stock/device-state";
import { nextDocNo } from "@/server/stock/doc-no";
import { StockError } from "@/server/stock/stock-service";
import { ApprovalRequiredError } from "./approval-check";
import { executorFor, type ApprovalExecutor, type ApprovalPayload, type ClosedStatus } from "./executors";

export type { ApprovalPayload } from "./executors";

// 审批单（口径第 17 节）：触发了规则的事先存成审批单；审批人通过时，系统以发起人的身份、按当时的数据把这件事做掉（同一个事务里改审批单状态）；
// 做不成（机器卖了、库存不够、当天已日结……）就记“批了没做成”和原因，发起人重新发起。
// 第 19 节扩了三处：每种事项通过、驳回后做什么在 executors.ts 登记；请假、报销这类 OA 事项可以不挂门店；可以两级审批（店长批完总部再批）。

export class ApprovalError extends Error {}

type Tx = Prisma.TransactionClient;

const DEFAULT_APPROVER: Record<ApprovalRuleKindKey, ApproverRoleKey> = {
  SALE_DISCOUNT: "STORE_MANAGER",
  SALE_BELOW_COST: "STORE_MANAGER",
  RETURN_REFUND: "STORE_MANAGER",
  SALE_VOID: "HQ",
  TRANSFER: "HQ",
  STOCKTAKE_LOSS: "HQ",
};
/** 这几个场景本来就是店长做的事，只能总部批 */
const HQ_ONLY: ApprovalRuleKindKey[] = ["SALE_VOID", "TRANSFER", "STOCKTAKE_LOSS"];

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function wrapAccess(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (error instanceof PermissionError) throw new ApprovalError(error.message);
    throw error;
  }
}

// ---------- 规则 ----------

/** 六个场景都列出来，没配过的按默认（关）显示 */
export async function listRules() {
  const rows = await prisma.approvalRule.findMany();
  return APPROVAL_RULE_KINDS.map((kind) => {
    const r = rows.find((x) => x.kind === kind);
    return { kind, enabled: r?.enabled ?? false, thresholdFen: r?.thresholdFen ?? null, thresholdBp: r?.thresholdBp ?? null, approverRole: (r?.approverRole ?? DEFAULT_APPROVER[kind]) as ApproverRoleKey, note: r?.note ?? null, updatedAt: r?.updatedAt ?? null, hqOnly: HQ_ONLY.includes(kind) };
  });
}

export async function saveRule(user: CurrentUser, input: { kind: unknown; enabled: unknown; thresholdFen?: unknown; thresholdBp?: unknown; approverRole?: unknown; note?: unknown }) {
  if (!canManageApprovalRules(user.role)) throw new ApprovalError("审批规则只有总部能改");
  const kind = input.kind as ApprovalRuleKindKey;
  if (!APPROVAL_RULE_KINDS.includes(kind)) throw new ApprovalError("场景不对");
  const enabled = input.enabled === true;
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  const thresholdFen = num(input.thresholdFen);
  if (thresholdFen !== null && !isValidFen(thresholdFen)) throw new ApprovalError("金额门槛不对");
  const thresholdBp = kind === "SALE_DISCOUNT" ? num(input.thresholdBp) : null;
  if (thresholdBp !== null && (!Number.isInteger(thresholdBp) || thresholdBp < 0 || thresholdBp > 10000)) throw new ApprovalError("比例门槛填 0～100%");
  if (enabled) {
    if (kind === "SALE_DISCOUNT" && !thresholdFen && !thresholdBp) throw new ApprovalError("开单让利要填金额或比例门槛（至少一个）");
    if (["RETURN_REFUND", "TRANSFER", "STOCKTAKE_LOSS"].includes(kind) && !thresholdFen) throw new ApprovalError("要填金额门槛");
  }
  const approverRole: ApproverRoleKey = HQ_ONLY.includes(kind) ? "HQ" : input.approverRole === "HQ" ? "HQ" : "STORE_MANAGER";
  const data = { enabled, thresholdFen, thresholdBp, approverRole, note: text(input.note, 100) || null };
  const rule = await prisma.approvalRule.upsert({ where: { kind }, create: { kind, ...data }, update: data });
  await writeAudit({ userId: user.id, action: "approval.rule.save", entity: "approval_rule", entityId: rule.id, detail: { kind, ...data } });
}

// ---------- 发起 ----------

/** Server Function 接住 ApprovalRequiredError 后调它：存一张待审批的单 */
export async function createApprovalRequest(user: CurrentUser, error: ApprovalRequiredError, payload: ApprovalPayload, note?: unknown, db: Db = prisma) {
  const { decision, context } = error;
  // 开单把单价写死了的，执行内容用写死的那份（审批期间改价不影响）
  if (context.frozenInput !== undefined && "input" in payload) payload = { ...payload, input: context.frozenInput } as ApprovalPayload;
  // 同一个人同样的内容提交两次（比如返回再点一次）：只留一张待审批的（部分唯一索引兜底）
  const dedupeKey = context.dedupeKey ?? `${context.action}:${user.id}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32)}`;
  try {
    return await withTx(db, async (tx) => {
      const requestNo = await nextDocNo(tx, "SP");
      const created = await tx.approvalRequest.create({
        data: {
          requestNo,
          action: context.action,
          storeId: context.storeId,
          requestedById: user.id,
          approverRole: decision.approverRole,
          summary: context.summary,
          reasons: decision.reasons,
          amountFen: decision.amountFen,
          note: text(note, 200) || null,
          payload: { ...payload, details: context.details } as Prisma.InputJsonValue,
          dedupeKey,
        },
      });
      await writeAudit({ userId: user.id, action: "approval.request", entity: "approval_request", entityId: created.id, detail: { requestNo, action: context.action, reasons: decision.reasons.map((r) => r.kind) } }, tx);
      return { id: created.id, requestNo, approverRole: decision.approverRole };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApprovalError("一样的内容已经有一张待审批的了，等审批人处理，不用重复提交");
    throw e;
  }
}

/**
 * OA 事项（请假、报销，口径第 19 节）提交就要批，不看第 17 节的规则：在调用方的事务里存一张审批单。
 * chain 是依次要谁批（店长 → 总部，或者只有总部）；storeId 可以是空（总部员工的事项）。
 */
export async function createOaApprovalTx(
  tx: Tx,
  user: CurrentUser,
  input: { action: "LEAVE" | "EXPENSE"; storeId: number | null; chain: ApproverRoleKey[]; summary: string; reason: string; amountFen: number; note?: string | null; payload: ApprovalPayload; dedupeKey: string },
) {
  if (input.chain.length === 0) throw new ApprovalError("没有审批人");
  const requestNo = await nextDocNo(tx, "SP");
  const created = await tx.approvalRequest.create({
    data: {
      requestNo,
      action: input.action,
      storeId: input.storeId,
      requestedById: user.id,
      approverRole: input.chain[0]!,
      chain: input.chain,
      step: 1,
      summary: input.summary,
      reasons: [{ kind: input.action, text: input.reason }],
      amountFen: input.amountFen,
      note: input.note ?? null,
      payload: input.payload as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey,
    },
  });
  await writeAudit({ userId: user.id, action: "approval.request", entity: "approval_request", entityId: created.id, detail: { requestNo, action: input.action, chain: input.chain } }, tx);
  if (user.role === "HQ") {
    // 第 17 节“总部做的都不用批”：总部本人的请假、报销提交就算通过（只有一个总部账号时也没人能批），审批单上记一笔
    const result = await executorOf(input.action).execute(tx, user, input.payload);
    await tx.approvalRequest.update({ where: { id: created.id }, data: { status: "EXECUTED", decidedById: user.id, decidedAt: new Date(), decisionNote: "总部本人，不用批（口径第 17 节）", resultId: result.id, resultNo: result.no } });
    await writeAudit({ userId: user.id, action: "approval.auto", entity: "approval_request", entityId: created.id, detail: { requestNo, action: input.action } }, tx);
    return { id: created.id, requestNo, approverRole: input.chain[0]!, autoApproved: true };
  }
  return { id: created.id, requestNo, approverRole: input.chain[0]!, autoApproved: false };
}

/**
 * 调店、停用的时候，把这个人审批中的请假自动撤回（口径第 19 节，2026-10-21 复查后补）：
 * 老店的审批人不该再批，两级的也不用转到总部才判“没做成”；调了店的人到新店重新提交。
 * 报销不撤：钱已经垫出去了，算的是当时那家店，照原来的门店和审批链批下去、照常付款。
 */
export async function cancelPendingOaFor(db: Db, userId: number, reason: string): Promise<number> {
  return withTx(db, async (tx) => {
    const rows = await tx.approvalRequest.findMany({ where: { requestedById: userId, status: "PENDING", action: "LEAVE" }, select: { id: true } });
    let count = 0;
    for (const { id } of rows) {
      if (!(await lockRow(tx, "approval_requests", id))) continue;
      const request = await tx.approvalRequest.findUniqueOrThrow({ where: { id } });
      if (request.status !== "PENDING") continue;
      await closeWith(tx, request, "CANCELLED");
      await tx.approvalRequest.update({ where: { id }, data: { status: "CANCELLED", decidedAt: new Date(), decisionNote: reason } });
      await writeAudit({ userId: null, action: "approval.auto_cancel", entity: "approval_request", entityId: id, detail: { requestNo: request.requestNo, reason } }, tx);
      count++;
    }
    return count;
  });
}

// ---------- 审批 ----------

/** 发起人现在的账号（审批通过时以他的身份执行；账号停用了就做不成） */
async function loadRequester(db: Tx, id: number): Promise<CurrentUser | null> {
  const u = await db.user.findUnique({ where: { id }, include: { store: true, region: true } });
  return u && u.isActive ? (u as unknown as CurrentUser) : null;
}

/** 登记过的执行器；没登记的事项（数据有问题）当程序出错 */
function executorOf(action: ApprovalActionKey): ApprovalExecutor {
  const executor = executorFor(action);
  if (!executor) throw new Error(`审批事项 ${action} 没有登记执行器`);
  return executor;
}

/** 这件事做不成的业务原因（不是程序出错）：记到审批单上给发起人看；数据库约束兜底拦下的也算 */
function businessMessage(executor: ApprovalExecutor, error: unknown): string | null {
  if (executor.businessErrors.some((E) => error instanceof E)) return (error as Error).message;
  if (error instanceof StockError || error instanceof DeviceStateError || error instanceof PermissionError) return error.message;
  if (isUniqueViolation(error) || isCheckViolation(error)) return "数据刚被别人改过（比如同一台机器、同一个码刚被用了），按现在的情况重新发起";
  return null;
}

/** 前面几级的审批记录 */
function stepLogOf(value: unknown): ApprovalStepEntry[] {
  return Array.isArray(value) ? (value as ApprovalStepEntry[]) : [];
}

/** 能不能看这张审批单：挂门店的按门店范围（店员只看自己发起的）；不挂门店的（总部员工的请假、报销）只有发起人和总部 */
function assertCanView(user: CurrentUser, request: { requestedById: number; store: { id: number; regionId: number } | null }) {
  if (request.requestedById === user.id) return;
  const store = request.store;
  if (store) wrapAccess(() => assertStoreAccess(user, store));
  else if (user.role !== "HQ") throw new ApprovalError("没有权限看这张审批单");
  if (user.role === "STAFF") throw new ApprovalError("店员只能看自己发起的审批单");
}

async function loadForDecision(db: Tx, user: CurrentUser, id: number) {
  if (!(await lockRow(db, "approval_requests", id))) throw new ApprovalError("审批单不存在");
  const request = await db.approvalRequest.findUniqueOrThrow({ where: { id }, include: { store: { select: { id: true, regionId: true } } } });
  const store = request.store;
  if (store) wrapAccess(() => assertStoreAccess(user, store));
  else if (user.role !== "HQ") throw new ApprovalError("这张要总部批");
  if (request.status !== "PENDING") throw new ApprovalError("这张审批单已经处理过了");
  const log = stepLogOf(request.stepLog);
  const decidedEarlier = log.some((e) => e.userId === user.id);
  if (!canDecide(request.approverRole as ApproverRoleKey, user.role, request.requestedById === user.id, decidedEarlier)) {
    throw new ApprovalError(request.requestedById === user.id ? "不能批自己发起的" : decidedEarlier ? "你已经批过前一级了，这一级要别人批" : request.approverRole === "HQ" ? "这张要总部批" : "这张要店长或总部批");
  }
  return { ...request, log };
}

/**
 * 通过：在一个事务里锁住审批单，设一个保存点，以发起人身份按当时的数据把事做掉，记“已通过”和做出来的单号；
 * 做不成（业务原因）就回到保存点（做了一半的全撤掉），记“批了没做成”和原因。审批单本身的问题（不存在、处理过了、没权限）直接报错。
 */
export type ApproveResult = { executed: true; resultId: number; resultNo: string | null } | { executed: false; error: string } | { executed: false; forwardedTo: ApproverRoleKey };

export async function approveRequest(user: CurrentUser, id: number, note?: unknown, db: Db = prisma): Promise<ApproveResult> {
  const decisionNote = text(note, 200) || null;
  return withTx(db, async (tx) => {
    const request = await loadForDecision(tx, user, id);
    const executor = executorOf(request.action);
    const payload = request.payload as unknown as ApprovalPayload;
    // 两级审批：这一级不是最后一级，只记一笔、转给下一级（口径第 19 节）
    const next = nextApprovalStep(request.chain as ApproverRoleKey[], request.step, user.role);
    if (next) {
      const entry: ApprovalStepEntry = { step: request.step, role: request.approverRole as ApproverRoleKey, userId: user.id, name: user.name, at: new Date().toISOString(), note: decisionNote };
      await tx.approvalRequest.update({ where: { id }, data: { step: next.step, approverRole: next.role, stepLog: [...request.log, entry] as unknown as Prisma.InputJsonValue } });
      await writeAudit({ userId: user.id, action: "approval.step", entity: "approval_request", entityId: id, detail: { requestNo: request.requestNo, step: request.step, next: next.role } }, tx);
      return { executed: false as const, forwardedTo: next.role };
    }
    const fail = async (message: string) => {
      await executor.onClosed?.(tx, payload, "FAILED");
      await tx.approvalRequest.update({ where: { id }, data: { status: "FAILED", decidedById: user.id, decidedAt: new Date(), decisionNote, error: message } });
      await writeAudit({ userId: user.id, action: "approval.failed", entity: "approval_request", entityId: id, detail: { requestNo: request.requestNo, error: message } }, tx);
      return { executed: false as const, error: message };
    };
    const requester = await loadRequester(tx, request.requestedById);
    const oa = OA_ACTIONS.includes(request.action);
    if (!executor.survivesRequesterLeaving) {
      if (!requester) return fail(oa ? "发起人的账号已经停用，这张单不再生效" : "发起人的账号已经停用，这件事做不成，请别人重新发起");
      if ((requester.role === "STAFF" || requester.role === "STORE_MANAGER") && requester.storeId !== request.storeId) return fail(oa ? "发起人已经调到别的店了，请他重新提交，由新门店审批" : "发起人已经调到别的店了，这件事做不成，请本店的人重新发起");
    }
    await tx.$executeRaw`SAVEPOINT approval_execute`;
    let result: { id: number; no: string | null };
    try {
      result = await executor.execute(tx, requester ?? user, payload); // 报销这类发起人走了也照样批的，执行时不用发起人的身份
    } catch (error) {
      const message = businessMessage(executor, error);
      if (message === null) throw error;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT approval_execute`;
      return fail(message);
    }
    await tx.$executeRaw`RELEASE SAVEPOINT approval_execute`;
    await tx.approvalRequest.update({ where: { id }, data: { status: "EXECUTED", decidedById: user.id, decidedAt: new Date(), decisionNote, resultId: result.id, resultNo: result.no } });
    await writeAudit({ userId: user.id, action: "approval.approve", entity: "approval_request", entityId: id, detail: { requestNo: request.requestNo, result: result.no } }, tx);
    return { executed: true as const, resultId: result.id, resultNo: result.no };
  });
}

/** 驳回、撤回时登记的执行器要跟着改的（比如请假单标成驳回） */
async function closeWith(tx: Tx, request: { action: ApprovalActionKey; payload: unknown }, status: ClosedStatus) {
  await executorOf(request.action).onClosed?.(tx, request.payload as ApprovalPayload, status);
}

/** 驳回：要写原因；在哪一级驳回都算结束 */
export async function rejectRequest(user: CurrentUser, id: number, note: unknown, db: Db = prisma) {
  const reason = text(note, 200);
  if (!reason) throw new ApprovalError("写一下驳回原因");
  await withTx(db, async (tx) => {
    const request = await loadForDecision(tx, user, id);
    await closeWith(tx, request, "REJECTED");
    await tx.approvalRequest.update({ where: { id }, data: { status: "REJECTED", decidedById: user.id, decidedAt: new Date(), decisionNote: reason } });
    await writeAudit({ userId: user.id, action: "approval.reject", entity: "approval_request", entityId: id, detail: { requestNo: request.requestNo, reason } }, tx);
  });
}

/** 撤回：发起人自己撤 */
export async function cancelRequest(user: CurrentUser, id: number, db: Db = prisma) {
  await withTx(db, async (tx) => {
    if (!(await lockRow(tx, "approval_requests", id))) throw new ApprovalError("审批单不存在");
    const request = await tx.approvalRequest.findUniqueOrThrow({ where: { id } });
    if (request.requestedById !== user.id) throw new ApprovalError("只有发起人能撤回");
    if (request.status !== "PENDING") throw new ApprovalError("这张审批单已经处理过了");
    await closeWith(tx, request, "CANCELLED");
    await tx.approvalRequest.update({ where: { id }, data: { status: "CANCELLED", decidedAt: new Date() } });
    await writeAudit({ userId: user.id, action: "approval.cancel", entity: "approval_request", entityId: id, detail: { requestNo: request.requestNo } }, tx);
  });
}

// ---------- 查询 ----------

export const APPROVAL_PAGE_SIZE = 20;
export type ApprovalView = "todo" | "mine" | "all";

/** 待我审批：店长看本店要店长批的，总部看全部；都不含自己发起的 */
function todoWhere(user: CurrentUser): Prisma.ApprovalRequestWhereInput {
  if (user.role === "HQ") return { status: "PENDING", requestedById: { not: user.id } };
  if (user.role === "STORE_MANAGER" && user.storeId) return { status: "PENDING", approverRole: "STORE_MANAGER", storeId: user.storeId, requestedById: { not: user.id } };
  return { id: -1 };
}

function viewWhere(user: CurrentUser, view: ApprovalView, status?: ApprovalStatus): Prisma.ApprovalRequestWhereInput {
  // 全部：按门店范围；不挂门店的只有总部看得到（storeScopeWhere 对总部是空条件），别人只在“我发起的”里看到自己的
  const base = view === "todo" ? todoWhere(user) : view === "mine" ? { requestedById: user.id } : { AND: [storeScopeWhere(user), user.role === "STAFF" ? { requestedById: user.id } : {}] };
  return { AND: [base, status ? { status } : {}] };
}

export async function listApprovals(user: CurrentUser, query: { view?: ApprovalView; status?: ApprovalStatus; page?: number }) {
  // 店长、总部默认看待我审批；店员看我发起的；区域经理批不了，默认看全部（辖区只读），“我发起的”里是他自己的请假、报销（不挂门店，“全部”里没有）
  const canDecideAny = user.role === "STORE_MANAGER" || user.role === "HQ";
  const fallback: ApprovalView = canDecideAny ? "todo" : user.role === "REGIONAL_MANAGER" ? "all" : "mine";
  let view = query.view ?? fallback;
  if (view === "todo" && !canDecideAny) view = fallback;
  const page = clampPage(query.page);
  const where = viewWhere(user, view, query.status);
  const [rows, total, todoCount] = await Promise.all([
    prisma.approvalRequest.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * APPROVAL_PAGE_SIZE,
      take: APPROVAL_PAGE_SIZE,
      omit: { payload: true }, // 列表不带执行内容
      include: { store: { select: { code: true, name: true } }, requestedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
    }),
    prisma.approvalRequest.count({ where }),
    prisma.approvalRequest.count({ where: todoWhere(user) }),
  ]);
  return { rows, total, page, pageSize: APPROVAL_PAGE_SIZE, view, todoCount, canManageRules: canManageApprovalRules(user.role) };
}

export type ApprovalRow = Awaited<ReturnType<typeof listApprovals>>["rows"][number];

/** 待我审批的数量（菜单、首页提醒用） */
export async function todoCount(user: CurrentUser): Promise<number> {
  if (user.role !== "STORE_MANAGER" && user.role !== "HQ") return 0;
  return prisma.approvalRequest.count({ where: todoWhere(user) });
}

/** 做出来的单据在哪儿看（执行器登记的） */
function resultHref(action: ApprovalActionKey, payload: ApprovalPayload, resultId: number | null): string | null {
  if (!resultId) return null;
  return executorFor(action)?.resultHref(payload as never, resultId) ?? null;
}

export async function getApproval(user: CurrentUser, id: number, db: Db = prisma) {
  const request = await db.approvalRequest.findUnique({
    where: { id },
    include: { store: { select: { id: true, code: true, name: true, regionId: true } }, requestedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
  });
  if (!request) return null;
  assertCanView(user, request);
  const payload = request.payload as unknown as ApprovalPayload;
  const stepLog = stepLogOf(request.stepLog);
  const inScope = request.store ? true : user.role === "HQ";
  return {
    ...request,
    payload: undefined,
    stepLog,
    chain: request.chain as ApproverRoleKey[],
    details: payload.details ?? [],
    reasons: (request.reasons as { kind: string; text: string }[]) ?? [],
    resultHref: resultHref(request.action, payload, request.resultId),
    can: {
      decide: request.status === "PENDING" && inScope && canDecide(request.approverRole as ApproverRoleKey, user.role, request.requestedById === user.id, stepLog.some((e) => e.userId === user.id)),
      cancel: request.status === "PENDING" && request.requestedById === user.id,
    },
  };
}

export type ApprovalDetail = NonNullable<Awaited<ReturnType<typeof getApproval>>>;

// ---------- 给各处 Server Function 用 ----------

/** 操作触发了审批规则时 Server Function 返回的样子：ok 是 false（这件事这次没做），带上审批单号 */
export type ApprovalSubmitted = { ok: false; error: string; approval: { id: number; requestNo: string } };

/** 接住 ApprovalRequiredError：存审批单，返回给页面的提示 */
export async function submitForApproval(user: CurrentUser, error: ApprovalRequiredError, payload: ApprovalPayload, note?: unknown): Promise<ApprovalSubmitted | { ok: false; error: string }> {
  try {
    const r = await createApprovalRequest(user, error, payload, note);
    return { ok: false, error: `${error.message}。已提交审批单 ${r.requestNo}，${r.approverRole === "HQ" ? "总部" : "店长"}批了系统自动做掉`, approval: { id: r.id, requestNo: r.requestNo } };
  } catch (e) {
    if (e instanceof ApprovalError) return { ok: false, error: e.message };
    throw e;
  }
}
