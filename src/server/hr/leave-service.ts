import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { clampPage } from "@/lib/paging";
import {
  addDays,
  bjDateKey,
  dateFromKey,
  dateKeyOf,
  isDateKey,
  isMonthKey,
  LEAVE_BACKDATE_DAYS,
  LEAVE_HQ_DAYS,
  LEAVE_KIND_LABELS,
  LEAVE_KINDS,
  LEAVE_MAX_DAYS,
  leaveChain,
  leaveDays,
  monthDates,
  OA_STATUS_LABELS,
  type LeaveKindKey,
  type OaStatusKey,
} from "@/lib/attendance";
import { canViewTeamAttendance } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { ApprovalError, cancelRequest, createOaApprovalTx } from "@/server/approval/approval-service";
import { writeAudit } from "@/server/audit";
import { type Db, withTx } from "@/server/db-tx";
import { LeaveError } from "./leave-executor";

// 请假（口径第 19 节）：员工自己发起（事假、病假、年假、调休），走审批：门店店员店长批，3 天及以上店长批完总部再批；
// 店长、区域经理、总部的人直接总部批。批了的日子考勤算请假、不算缺勤。审批中的可以撤回；批了的这一版不能撤（不做销假）。

export { LeaveError };

const LEAVE_LOCK_NS = -78; // 咨询锁命名空间见 attendance-service.ts
const FORWARD_DAYS = 180; // 最多提前半年请
export const LEAVE_PAGE_SIZE = 20;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function submitLeave(user: CurrentUser, input: { kind: unknown; startDate: unknown; endDate: unknown; reason: unknown }, opts: { db?: Db; now?: Date } = {}) {
  const kind = input.kind as LeaveKindKey;
  if (!LEAVE_KINDS.includes(kind)) throw new LeaveError("选一下请假类型");
  if (!isDateKey(input.startDate) || !isDateKey(input.endDate)) throw new LeaveError("开始、结束日期都要填");
  const start = input.startDate;
  const end = input.endDate;
  if (end < start) throw new LeaveError("结束日期不能早于开始日期");
  const days = leaveDays(start, end);
  if (days > LEAVE_MAX_DAYS) throw new LeaveError(`一次最多请 ${LEAVE_MAX_DAYS} 天`);
  const today = bjDateKey(opts.now ?? new Date());
  if (start < addDays(today, -LEAVE_BACKDATE_DAYS)) throw new LeaveError(`最多补请 ${LEAVE_BACKDATE_DAYS} 天以内的假`);
  if (start > addDays(today, FORWARD_DAYS)) throw new LeaveError(`最多提前 ${FORWARD_DAYS} 天请假`);
  const reason = text(input.reason, 200);
  if (!reason) throw new LeaveError("写一下请假事由");
  const chain = leaveChain(user.role, user.storeId !== null, days);
  return withTx(opts.db ?? prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEAVE_LOCK_NS}::int, ${user.id}::int)`; // 同一个人同时提交两张，重叠检查不会都放过
    const overlap = await tx.leaveRequest.findFirst({ where: { userId: user.id, status: { in: ["PENDING", "APPROVED"] }, startDate: { lte: dateFromKey(end) }, endDate: { gte: dateFromKey(start) } } });
    if (overlap) throw new LeaveError(`和已有的请假（${dateKeyOf(overlap.startDate)}～${dateKeyOf(overlap.endDate)}，${OA_STATUS_LABELS[overlap.status]}）重叠了${overlap.status === "PENDING" ? "；要改日期，先在请假页撤回那张" : ""}`);
    const leave = await tx.leaveRequest.create({ data: { userId: user.id, storeId: user.storeId, kind, startDate: dateFromKey(start), endDate: dateFromKey(end), days, reason } });
    const label = LEAVE_KIND_LABELS[kind];
    const approval = await createOaApprovalTx(tx, user, {
      action: "LEAVE",
      storeId: user.storeId,
      chain,
      summary: `${user.name} ${label} ${start}～${end}，共 ${days} 天`,
      reason: chain.length > 1 ? `请假 ${days} 天（${LEAVE_HQ_DAYS} 天及以上），店长批完总部再批` : "请假要审批",
      amountFen: 0,
      payload: { action: "LEAVE", leaveId: leave.id, details: [`类型：${label}`, `日期：${start} ～ ${end}，共 ${days} 天`, `事由：${reason}`] },
      dedupeKey: `LEAVE:${leave.id}`,
    });
    await tx.leaveRequest.update({ where: { id: leave.id }, data: { approvalRequestId: approval.id } });
    await writeAudit({ userId: user.id, action: "leave.submit", entity: "leave_request", entityId: leave.id, detail: { kind, start, end, days, requestNo: approval.requestNo } }, tx);
    return { id: leave.id, requestNo: approval.requestNo, approverRole: approval.approverRole, chain, autoApproved: approval.autoApproved };
  });
}

/** 撤回自己审批中的请假（就是撤回那张审批单） */
export async function cancelLeave(user: CurrentUser, leaveId: number, db: Db = prisma) {
  const leave = await db.leaveRequest.findUnique({ where: { id: leaveId }, select: { userId: true, status: true, approvalRequestId: true } });
  if (!leave || leave.userId !== user.id) throw new LeaveError("只能撤回自己的请假");
  if (leave.status !== "PENDING" || !leave.approvalRequestId) throw new LeaveError("这张请假单已经处理过了，批了的不能撤回");
  try {
    await cancelRequest(user, leave.approvalRequestId, db);
  } catch (error) {
    if (error instanceof ApprovalError) throw new LeaveError(error.message);
    throw error;
  }
}

export type LeaveView = "mine" | "team";

/** 能看谁的请假：我自己的；店长本店、区域经理辖区、总部全部（不挂门店的总部员工只有总部看得到） */
function teamWhere(user: CurrentUser): Prisma.LeaveRequestWhereInput {
  switch (user.role) {
    case "HQ":
      return {};
    case "REGIONAL_MANAGER":
      return { store: { regionId: user.regionId ?? -1 } };
    case "STORE_MANAGER":
      return { storeId: user.storeId ?? -1 };
    case "STAFF":
      return { userId: user.id };
  }
}

export async function listLeaves(user: CurrentUser, query: { view?: LeaveView; month?: string; status?: OaStatusKey; page?: number }) {
  const team = canViewTeamAttendance(user.role);
  const view: LeaveView = query.view === "team" && team ? "team" : "mine";
  const page = clampPage(query.page);
  const month = isMonthKey(query.month) ? query.month : null;
  const where: Prisma.LeaveRequestWhereInput = {
    AND: [
      view === "mine" ? { userId: user.id } : teamWhere(user),
      month ? { startDate: { lte: dateFromKey(monthDates(month).at(-1)!) }, endDate: { gte: dateFromKey(`${month}-01`) } } : {},
      query.status ? { status: query.status } : {},
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where,
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      skip: (page - 1) * LEAVE_PAGE_SIZE,
      take: LEAVE_PAGE_SIZE,
      include: { user: { select: { name: true } }, store: { select: { code: true, name: true } } },
    }),
    prisma.leaveRequest.count({ where }),
  ]);
  const approvals = await prisma.approvalRequest.findMany({
    where: { id: { in: rows.map((r) => r.approvalRequestId).filter((id): id is number => id !== null) } },
    select: { id: true, requestNo: true, approverRole: true, step: true, chain: true, status: true, decisionNote: true },
  });
  return {
    view,
    team,
    page,
    pageSize: LEAVE_PAGE_SIZE,
    total,
    rows: rows.map((r) => {
      const a = approvals.find((x) => x.id === r.approvalRequestId) ?? null;
      return {
        id: r.id,
        name: r.user.name,
        store: r.store ? `${r.store.code} ${r.store.name}` : "总部",
        kind: r.kind,
        startDate: dateKeyOf(r.startDate),
        endDate: dateKeyOf(r.endDate),
        days: r.days,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
        mine: r.userId === user.id,
        approval: a ? { id: a.id, requestNo: a.requestNo, approverRole: a.approverRole, step: a.step, steps: Math.max(1, a.chain.length), note: a.status === "REJECTED" ? a.decisionNote : null } : null,
      };
    }),
  };
}

export type LeaveList = Awaited<ReturnType<typeof listLeaves>>;
