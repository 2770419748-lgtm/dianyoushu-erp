import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { ApprovalStatus } from "@/generated/prisma/enums";
import { APPROVAL_RULE_KINDS, canDecide, type ApprovalActionKey, type ApprovalRuleKindKey, type ApproverRoleKey } from "@/lib/approval";
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
import { createReturnTx, ReturnError, type ReturnInput } from "@/server/sales/return-service";
import { createSalesOrderTx, SalesError, voidSalesOrderTx, type SalesOrderInput } from "@/server/sales/sales-service";
import { confirmStocktakeTx, StocktakeError } from "@/server/stocktake/stocktake-service";
import { createTransferTx, TransferError, type TransferInput } from "@/server/transfer/transfer-service";
import { SubsidyError } from "@/server/subsidy/subsidy-service";
import { ApprovalRequiredError } from "./approval-check";

// 审批单（口径第 17 节）：触发了规则的事先存成审批单；审批人通过时，系统以发起人的身份、按当时的数据把这件事做掉（同一个事务里改审批单状态）；
// 做不成（机器卖了、库存不够、当天已日结……）就记“批了没做成”和原因，发起人重新发起。

export class ApprovalError extends Error {}

type Tx = Prisma.TransactionClient;

/** 每种事的审批单里存的内容 */
export type ApprovalPayload =
  | { action: "SALE"; input: SalesOrderInput; details: string[] }
  | { action: "RETURN"; input: ReturnInput; details: string[] }
  | { action: "SALE_VOID"; orderId: number; reason: string; details: string[] }
  | { action: "TRANSFER"; input: TransferInput; details: string[] }
  | { action: "STOCKTAKE"; stocktakeId: number; details: string[] };

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
          dedupeKey: context.dedupeKey,
        },
      });
      await writeAudit({ userId: user.id, action: "approval.request", entity: "approval_request", entityId: created.id, detail: { requestNo, action: context.action, reasons: decision.reasons.map((r) => r.kind) } }, tx);
      return { id: created.id, requestNo, approverRole: decision.approverRole };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApprovalError("这件事已经有一张待审批的了，等审批人处理");
    throw e;
  }
}

// ---------- 审批 ----------

/** 发起人现在的账号（审批通过时以他的身份执行；账号停用了就做不成） */
async function loadRequester(db: Tx, id: number): Promise<CurrentUser | null> {
  const u = await db.user.findUnique({ where: { id }, include: { store: true, region: true } });
  return u && u.isActive ? (u as unknown as CurrentUser) : null;
}

/** 按当时的数据把这件事做掉（带 approved: true，不再检查审批） */
async function execute(tx: Tx, requester: CurrentUser, payload: ApprovalPayload): Promise<{ id: number; no: string | null }> {
  switch (payload.action) {
    case "SALE": {
      const r = await createSalesOrderTx(tx, requester, payload.input, { approved: true });
      return { id: r.id, no: r.orderNo };
    }
    case "RETURN": {
      const r = await createReturnTx(tx, requester, payload.input, { approved: true });
      return { id: r.id, no: r.orderNo };
    }
    case "SALE_VOID": {
      await voidSalesOrderTx(tx, requester, payload.orderId, payload.reason, { approved: true });
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: payload.orderId }, select: { orderNo: true } });
      return { id: payload.orderId, no: order.orderNo };
    }
    case "TRANSFER": {
      const r = await createTransferTx(tx, requester, payload.input, { approved: true });
      return { id: r.id, no: r.orderNo };
    }
    case "STOCKTAKE": {
      const r = await confirmStocktakeTx(tx, requester, payload.stocktakeId, { approved: true });
      return { id: r.id, no: r.stocktakeNo };
    }
  }
}

/** 这件事做不成的业务原因（不是程序出错）：记到审批单上给发起人看；数据库约束兜底拦下的也算 */
function businessMessage(error: unknown): string | null {
  if (error instanceof SalesError || error instanceof ReturnError || error instanceof TransferError || error instanceof StocktakeError || error instanceof SubsidyError) return error.message;
  if (error instanceof StockError || error instanceof DeviceStateError || error instanceof PermissionError) return error.message;
  if (isUniqueViolation(error) || isCheckViolation(error)) return "数据刚被别人改过（比如同一台机器、同一个码刚被用了），按现在的情况重新发起";
  return null;
}

async function loadForDecision(db: Tx, user: CurrentUser, id: number) {
  if (!(await lockRow(db, "approval_requests", id))) throw new ApprovalError("审批单不存在");
  const request = await db.approvalRequest.findUniqueOrThrow({ where: { id }, include: { store: { select: { id: true, regionId: true } } } });
  wrapAccess(() => assertStoreAccess(user, request.store));
  if (request.status !== "PENDING") throw new ApprovalError("这张审批单已经处理过了");
  if (!canDecide(request.approverRole as ApproverRoleKey, user.role, request.requestedById === user.id)) {
    throw new ApprovalError(request.requestedById === user.id ? "不能批自己发起的" : request.approverRole === "HQ" ? "这张要总部批" : "这张要店长或总部批");
  }
  return request;
}

/**
 * 通过：在一个事务里锁住审批单，设一个保存点，以发起人身份按当时的数据把事做掉，记“已通过”和做出来的单号；
 * 做不成（业务原因）就回到保存点（做了一半的全撤掉），记“批了没做成”和原因。审批单本身的问题（不存在、处理过了、没权限）直接报错。
 */
export async function approveRequest(user: CurrentUser, id: number, note?: unknown, db: Db = prisma): Promise<{ executed: true; resultId: number; resultNo: string | null } | { executed: false; error: string }> {
  const decisionNote = text(note, 200) || null;
  return withTx(db, async (tx) => {
    const request = await loadForDecision(tx, user, id);
    const fail = async (message: string) => {
      await tx.approvalRequest.update({ where: { id }, data: { status: "FAILED", decidedById: user.id, decidedAt: new Date(), decisionNote, error: message } });
      await writeAudit({ userId: user.id, action: "approval.failed", entity: "approval_request", entityId: id, detail: { requestNo: request.requestNo, error: message } }, tx);
      return { executed: false as const, error: message };
    };
    const requester = await loadRequester(tx, request.requestedById);
    if (!requester) return fail("发起人的账号已经停用，这件事做不成，请别人重新发起");
    await tx.$executeRaw`SAVEPOINT approval_execute`;
    let result: { id: number; no: string | null };
    try {
      result = await execute(tx, requester, request.payload as unknown as ApprovalPayload);
    } catch (error) {
      const message = businessMessage(error);
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

/** 驳回：要写原因 */
export async function rejectRequest(user: CurrentUser, id: number, note: unknown, db: Db = prisma) {
  const reason = text(note, 200);
  if (!reason) throw new ApprovalError("写一下驳回原因");
  await withTx(db, async (tx) => {
    const request = await loadForDecision(tx, user, id);
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
  const base = view === "todo" ? todoWhere(user) : view === "mine" ? { requestedById: user.id } : { AND: [storeScopeWhere(user), user.role === "STAFF" ? { requestedById: user.id } : {}] };
  return { AND: [base, status ? { status } : {}] };
}

export async function listApprovals(user: CurrentUser, query: { view?: ApprovalView; status?: ApprovalStatus; page?: number }) {
  const view = query.view ?? (user.role === "STORE_MANAGER" || user.role === "HQ" ? "todo" : "mine");
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

/** 做出来的单据在哪儿看 */
function resultHref(action: ApprovalActionKey, payload: ApprovalPayload, resultId: number | null): string | null {
  if (!resultId) return null;
  switch (action) {
    case "SALE":
    case "SALE_VOID":
      return `/sales/${resultId}`;
    case "RETURN":
      return payload.action === "RETURN" ? `/sales/${Number(payload.input.salesOrderId)}` : null;
    case "TRANSFER":
      return `/transfers/${resultId}`;
    case "STOCKTAKE":
      return `/stocktakes/${resultId}`;
  }
}

export async function getApproval(user: CurrentUser, id: number) {
  const request = await prisma.approvalRequest.findUnique({
    where: { id },
    include: { store: { select: { id: true, code: true, name: true, regionId: true } }, requestedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
  });
  if (!request) return null;
  wrapAccess(() => assertStoreAccess(user, request.store));
  if (user.role === "STAFF" && request.requestedById !== user.id) throw new ApprovalError("店员只能看自己发起的审批单");
  const payload = request.payload as unknown as ApprovalPayload;
  return {
    ...request,
    payload: undefined,
    details: payload.details ?? [],
    reasons: (request.reasons as { kind: string; text: string }[]) ?? [],
    resultHref: resultHref(request.action, payload, request.resultId),
    can: {
      decide: request.status === "PENDING" && canDecide(request.approverRole as ApproverRoleKey, user.role, request.requestedById === user.id),
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
