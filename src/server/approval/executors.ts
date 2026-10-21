import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { ApprovalActionKey } from "@/lib/approval";
import type { CurrentUser } from "@/server/auth/current-user";
import { approveLeaveTx, closeLeaveTx, LeaveError } from "@/server/hr/leave-executor";
import { createReturnTx, ReturnError, type ReturnInput } from "@/server/sales/return-service";
import { createSalesOrderTx, SalesError, voidSalesOrderTx, type SalesOrderInput } from "@/server/sales/sales-service";
import { confirmStocktakeTx, StocktakeError } from "@/server/stocktake/stocktake-service";
import { SubsidyError } from "@/server/subsidy/subsidy-service";
import { createTransferTx, TransferError, type TransferInput } from "@/server/transfer/transfer-service";

// 审批执行器登记表（口径第 19 节“审批要先扩的三处”）：每种能审批的事项在这里登记
// 批到最后一级时做什么、驳回撤回（或批了没做成）时做什么、做出来的单据在哪儿看、哪些错误算“做不成”。
// 审批服务只认这张表，加一种事项（比如费用报销）只加一条登记，不用改审批本身。

type Tx = Prisma.TransactionClient;

/** 每种事的审批单里存的内容 */
export type ApprovalPayload =
  | { action: "SALE"; input: SalesOrderInput; details: string[] }
  | { action: "RETURN"; input: ReturnInput; details: string[] }
  | { action: "SALE_VOID"; orderId: number; reason: string; details: string[] }
  | { action: "TRANSFER"; input: TransferInput; details: string[] }
  | { action: "STOCKTAKE"; stocktakeId: number; details: string[] }
  | { action: "LEAVE"; leaveId: number; details: string[] };

export type ClosedStatus = "REJECTED" | "CANCELLED" | "FAILED";

export interface ApprovalExecutor<P extends ApprovalPayload = ApprovalPayload> {
  /** 批到最后一级：以发起人身份、按当时的数据把这件事做掉，返回做出来的单据 */
  execute(tx: Tx, requester: CurrentUser, payload: P): Promise<{ id: number; no: string | null }>;
  /** 驳回、撤回、批了没做成时要跟着改的（比如请假单标成驳回）；没有就不登记 */
  onClosed?(tx: Tx, payload: P, status: ClosedStatus): Promise<void>;
  /** 做出来的单据在哪儿看 */
  resultHref(payload: P, resultId: number): string | null;
  /** 这些错误算“做不成”的业务原因（记到审批单上给发起人看），别的错误算程序出错 */
  businessErrors: (abstract new (...args: never[]) => Error)[];
}

type Registry = { [K in ApprovalPayload["action"]]: ApprovalExecutor<Extract<ApprovalPayload, { action: K }>> };

const EXECUTORS: Registry = {
  SALE: {
    execute: async (tx, requester, p) => {
      const r = await createSalesOrderTx(tx, requester, p.input, { approved: true });
      return { id: r.id, no: r.orderNo };
    },
    resultHref: (_, id) => `/sales/${id}`,
    businessErrors: [SalesError, SubsidyError],
  },
  RETURN: {
    execute: async (tx, requester, p) => {
      const r = await createReturnTx(tx, requester, p.input, { approved: true });
      return { id: r.id, no: r.orderNo };
    },
    resultHref: (p) => `/sales/${Number(p.input.salesOrderId)}`,
    businessErrors: [ReturnError, SalesError, SubsidyError],
  },
  SALE_VOID: {
    execute: async (tx, requester, p) => {
      await voidSalesOrderTx(tx, requester, p.orderId, p.reason, { approved: true });
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: p.orderId }, select: { orderNo: true } });
      return { id: p.orderId, no: order.orderNo };
    },
    resultHref: (_, id) => `/sales/${id}`,
    businessErrors: [SalesError, SubsidyError],
  },
  TRANSFER: {
    execute: async (tx, requester, p) => {
      const r = await createTransferTx(tx, requester, p.input, { approved: true });
      return { id: r.id, no: r.orderNo };
    },
    resultHref: (_, id) => `/transfers/${id}`,
    businessErrors: [TransferError],
  },
  STOCKTAKE: {
    execute: async (tx, requester, p) => {
      const r = await confirmStocktakeTx(tx, requester, p.stocktakeId, { approved: true });
      return { id: r.id, no: r.stocktakeNo };
    },
    resultHref: (_, id) => `/stocktakes/${id}`,
    businessErrors: [StocktakeError],
  },
  LEAVE: {
    execute: (tx, _requester, p) => approveLeaveTx(tx, p.leaveId),
    onClosed: (tx, p, status) => closeLeaveTx(tx, p.leaveId, status),
    resultHref: () => "/hr/leaves",
    businessErrors: [LeaveError],
  },
};

/** 这种事项登记的执行器；没登记的（比如还没做的事项）返回 null */
export function executorFor(action: ApprovalActionKey): ApprovalExecutor | null {
  return (EXECUTORS as unknown as Partial<Record<ApprovalActionKey, ApprovalExecutor>>)[action] ?? null;
}
