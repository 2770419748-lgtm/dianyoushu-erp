import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { InvoiceStatus } from "@/generated/prisma/enums";
import { monthRange } from "@/lib/carrier";
import { buildInvoiceLines, INVOICE_ACTIVE_STATUSES, InvoiceRuleError, normalizeInvoiceNumber, simulateInvoiceNumber, validateInvoiceTitle, type InvoiceTitleInput } from "@/lib/invoice";
import { canManageInvoice, canMarkInvoiceDelivered, canSell } from "@/server/auth/permissions";
import { assertStoreAccess, canAccessStoreSafe, PermissionError, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { lockRow } from "@/server/db-lock";
import { type Db, withTx } from "@/server/db-tx";
import { nextDocNo, todayBizDate, todayBizDateText } from "@/server/stock/doc-no";

// 发票（口径第 16 节）：门店从销售单申请开票，总部开具（数电票接口做成模拟，真用时在电子税务局开好回来登记号码）、红冲；
// 销售单退货、作废时，待开票的自动撤回、已开票的标“需红冲”；国补单提交审核时自动带出这张单的发票号码。

export class InvoiceError extends Error {}

type Tx = Prisma.TransactionClient;

function isDemo(): boolean {
  return process.env.DEMO_MODE !== "0";
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function wrapAccess(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (error instanceof PermissionError) throw new InvoiceError(error.message);
    throw error;
  }
}

function assertHq(user: CurrentUser) {
  if (!canManageInvoice(user.role)) throw new InvoiceError("开具、红冲发票和公司开票信息只有总部能做");
}

// ---------- 公司开票信息 ----------

export async function getSeller(db: Db = prisma) {
  return db.invoiceSeller.findUnique({ where: { id: 1 } });
}

export async function saveSeller(user: CurrentUser, input: { name: unknown; taxNo: unknown; addressPhone: unknown; bankAccount: unknown }) {
  assertHq(user);
  const name = text(input.name, 100);
  const taxNo = text(input.taxNo, 20).toUpperCase();
  const addressPhone = text(input.addressPhone, 100);
  const bankAccount = text(input.bankAccount, 100);
  if (!name || !addressPhone || !bankAccount) throw new InvoiceError("公司名称、地址电话、开户行及账号都要填");
  if (!/^[0-9A-Z]{15,20}$/.test(taxNo)) throw new InvoiceError("纳税人识别号是 15～20 位字母数字");
  const data = { name, taxNo, addressPhone, bankAccount };
  await prisma.invoiceSeller.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  await writeAudit({ userId: user.id, action: "invoice.seller.save", entity: "invoice_seller", entityId: 1, detail: data });
}

// ---------- 申请 ----------

async function orderForInvoice(db: Db, salesOrderId: number) {
  return db.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      store: { select: { id: true, code: true, name: true, regionId: true } },
      customer: { select: { id: true, name: true } },
      items: { orderBy: { id: "asc" }, include: { sku: { select: { name: true, isService: true } }, device: { select: { code: true } } } },
    },
  });
}

function draftLines(order: NonNullable<Awaited<ReturnType<typeof orderForInvoice>>>) {
  return buildInvoiceLines(
    order.items.map((i) => ({ salesOrderItemId: i.id, name: i.sku.name, spec: i.device?.code ?? null, qty: i.qty, returnedQty: i.returnedQty, lineTotalFen: i.lineTotalFen, isService: i.sku.isService })),
    order,
  );
}

/** 申请开票页要的：这张单能开多少、明细、为什么不能开、这个客户上次的抬头 */
export async function invoiceDraft(user: CurrentUser, salesOrderId: number) {
  const order = await orderForInvoice(prisma, salesOrderId);
  if (!order) return null;
  wrapAccess(() => assertStoreAccess(user, order.store));
  const lines = draftLines(order);
  const active = await prisma.invoice.findFirst({ where: { salesOrderId, status: { in: INVOICE_ACTIVE_STATUSES } }, select: { id: true, requestNo: true, status: true } });
  const blocked = !canSell(user.role) ? "你的角色不能申请开票" : order.status !== "COMPLETED" ? "作废的单不能开票" : active ? `这张单已经有在办的发票 ${active.requestNo}` : lines.length === 0 ? "这张单没有可开票的金额（都退了）" : null;
  const last = order.customer ? await prisma.invoice.findFirst({ where: { customerId: order.customer.id, status: { not: "CANCELLED" } }, orderBy: { id: "desc" }, select: { kind: true, titleType: true, titleName: true, buyerTaxNo: true, buyerAddressPhone: true, buyerBankAccount: true, receiver: true } }) : null;
  return {
    order: { id: order.id, orderNo: order.orderNo, bizDate: order.bizDate, totalFen: order.totalFen, store: { code: order.store.code, name: order.store.name }, customer: order.customer },
    lines,
    amountFen: lines.reduce((s, l) => s + l.amountFen, 0),
    taxFen: lines.reduce((s, l) => s + l.taxFen, 0),
    blocked,
    activeId: active?.id ?? null,
    lastTitle: last,
  };
}

export async function requestInvoiceTx(tx: Tx, user: CurrentUser, input: { salesOrderId: unknown } & InvoiceTitleInput) {
  if (!canSell(user.role)) throw new InvoiceError("你的角色不能申请开票");
  const salesOrderId = Number(input.salesOrderId);
  if (!Number.isInteger(salesOrderId) || !(await lockRow(tx, "sales_orders", salesOrderId))) throw new InvoiceError("销售单不存在");
  const order = (await orderForInvoice(tx, salesOrderId))!;
  wrapAccess(() => assertStoreAccess(user, order.store));
  if (order.status !== "COMPLETED") throw new InvoiceError("作废的单不能开票");
  const active = await tx.invoice.findFirst({ where: { salesOrderId, status: { in: INVOICE_ACTIVE_STATUSES } }, select: { requestNo: true } });
  if (active) throw new InvoiceError(`这张单已经有在办的发票 ${active.requestNo}，红冲或撤回之后才能再申请`);
  let title;
  try {
    title = validateInvoiceTitle(input);
  } catch (error) {
    if (error instanceof InvoiceRuleError) throw new InvoiceError(error.message);
    throw error;
  }
  const lines = draftLines(order);
  if (lines.length === 0) throw new InvoiceError("这张单没有可开票的金额（都退了）");
  const requestNo = await nextDocNo(tx, "KP");
  const invoice = await tx.invoice.create({
    data: {
      requestNo,
      storeId: order.storeId,
      salesOrderId,
      customerId: order.customerId,
      ...title,
      amountFen: lines.reduce((s, l) => s + l.amountFen, 0),
      taxFen: lines.reduce((s, l) => s + l.taxFen, 0),
      requestedById: user.id,
      lines: { create: lines },
    },
  });
  await writeAudit({ userId: user.id, action: "invoice.request", entity: "invoice", entityId: invoice.id, detail: { requestNo, orderNo: order.orderNo, kind: title.kind, amountFen: invoice.amountFen } }, tx);
  return { id: invoice.id, requestNo };
}

async function lockInvoice(tx: Tx, user: CurrentUser, id: number) {
  if (!(await lockRow(tx, "invoices", id))) throw new InvoiceError("发票不存在");
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { store: { select: { id: true, regionId: true } } } });
  wrapAccess(() => assertStoreAccess(user, invoice.store));
  return invoice;
}

/** 撤回：还没开的不要了（申请人、店长、总部） */
export async function cancelInvoiceTx(tx: Tx, user: CurrentUser, id: number, reason: unknown) {
  const invoice = await lockInvoice(tx, user, id);
  if (!(invoice.requestedById === user.id || user.role === "STORE_MANAGER" || user.role === "HQ")) throw new InvoiceError("只有申请人、店长和总部能撤回");
  if (invoice.status !== "REQUESTED") throw new InvoiceError("待开票的才能撤回；开了的要红冲");
  await tx.invoice.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: text(reason, 200) || "门店撤回" } });
  await writeAudit({ userId: user.id, action: "invoice.cancel", entity: "invoice", entityId: id, detail: { requestNo: invoice.requestNo } }, tx);
}

/** 当天的数电票模拟号码：按天计数，和真号码同样 20 位 */
async function simulatedNumber(tx: Tx): Promise<string> {
  const key = `FPNUM${todayBizDateText()}`;
  const counter = await tx.docCounter.upsert({ where: { key }, update: { value: { increment: 1 } }, create: { key, value: 1 } });
  return simulateInvoiceNumber(counter.value, todayBizDate());
}

async function resolveNumber(tx: Tx, raw: unknown, label: string): Promise<{ number: string; source: "SIMULATED" | "MANUAL" }> {
  if (typeof raw === "string" && raw.trim()) {
    const number = normalizeInvoiceNumber(raw);
    if (!number) throw new InvoiceError(`${label}是 8～20 位数字`);
    const dup = await tx.invoice.findFirst({ where: { OR: [{ invoiceNumber: number }, { redNumber: number }] }, select: { requestNo: true } });
    if (dup) throw new InvoiceError(`${label} ${number} 已经登记在 ${dup.requestNo} 上了`);
    return { number, source: "MANUAL" };
  }
  if (!isDemo()) throw new InvoiceError(`填电子税务局开好的${label}（没有对接开票接口）`);
  return { number: await simulatedNumber(tx), source: "SIMULATED" };
}

/** 开具（总部）：演示里不填号码就模拟开一张；真用时填电子税务局开好的号码 */
export async function issueInvoiceTx(tx: Tx, user: CurrentUser, id: number, input: { invoiceNumber?: unknown } = {}) {
  assertHq(user);
  const invoice = await lockInvoice(tx, user, id);
  if (invoice.status !== "REQUESTED") throw new InvoiceError("待开票的才能开具");
  const seller = await getSeller(tx);
  if (!seller) throw new InvoiceError("先在“公司开票信息”里填好销售方信息");
  const { number, source } = await resolveNumber(tx, input.invoiceNumber, "发票号码");
  await tx.invoice.update({
    where: { id },
    data: { status: "ISSUED", invoiceNumber: number, issueSource: source, issuedAt: new Date(), issuedById: user.id, sellerSnapshot: { name: seller.name, taxNo: seller.taxNo, addressPhone: seller.addressPhone, bankAccount: seller.bankAccount } },
  });
  await writeAudit({ userId: user.id, action: "invoice.issue", entity: "invoice", entityId: id, detail: { requestNo: invoice.requestNo, invoiceNumber: number, source } }, tx);
  return { invoiceNumber: number };
}

/** 红冲（总部）：开了之后退货、作废的（需红冲），或者开错了的（已开票） */
export async function redInvoiceTx(tx: Tx, user: CurrentUser, id: number, input: { redNumber?: unknown; reason: unknown }) {
  assertHq(user);
  const invoice = await lockInvoice(tx, user, id);
  if (invoice.status !== "ISSUED" && invoice.status !== "RED_PENDING") throw new InvoiceError("已开票、需红冲的才能红冲");
  const reason = text(input.reason, 200) || (invoice.status === "RED_PENDING" ? invoice.cancelReason ?? "" : "");
  if (!reason) throw new InvoiceError("写一下红冲原因");
  const { number } = await resolveNumber(tx, input.redNumber, "红字发票号码");
  await tx.invoice.update({ where: { id }, data: { status: "REDDED", redNumber: number, redAt: new Date(), redById: user.id, redReason: reason } });
  await writeAudit({ userId: user.id, action: "invoice.red", entity: "invoice", entityId: id, detail: { requestNo: invoice.requestNo, redNumber: number, reason } }, tx);
}

/** 纸质票寄到门店了（店长、总部） */
export async function markDeliveredTx(tx: Tx, user: CurrentUser, id: number) {
  if (!canMarkInvoiceDelivered(user.role)) throw new InvoiceError("店长和总部才能确认纸质票到店");
  const invoice = await lockInvoice(tx, user, id);
  if (invoice.kind !== "PAPER_NORMAL" || invoice.status !== "ISSUED" || invoice.deliveredAt) throw new InvoiceError("开好还没到店的纸质票才能点到店");
  await tx.invoice.update({ where: { id }, data: { deliveredAt: new Date() } });
  await writeAudit({ userId: user.id, action: "invoice.delivered", entity: "invoice", entityId: id, detail: { requestNo: invoice.requestNo } }, tx);
}

/**
 * 销售单退货、作废之后（在同一个事务里调用）：待开票的自动撤回（按剩下的重新申请），已开票的标“需红冲”。
 * 返回 { cancelled, redPending } 张数，页面拿来提示。
 */
export async function onOrderChangedTx(tx: Tx, salesOrderId: number, what: "退货" | "作废") {
  const now = new Date();
  const cancelled = await tx.invoice.updateMany({ where: { salesOrderId, status: "REQUESTED" }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: `销售单${what}，自动撤回；要开票按剩下的商品重新申请` } });
  const redPending = await tx.invoice.updateMany({ where: { salesOrderId, status: "ISSUED" }, data: { status: "RED_PENDING", cancelReason: `销售单${what}，要红冲` } });
  return { cancelled: cancelled.count, redPending: redPending.count };
}

export const invoiceActions = {
  request: (user: CurrentUser, input: { salesOrderId: unknown } & InvoiceTitleInput) => withTx(prisma, (tx) => requestInvoiceTx(tx, user, input)),
  cancel: (user: CurrentUser, id: number, reason: unknown) => withTx(prisma, (tx) => cancelInvoiceTx(tx, user, id, reason)),
  issue: (user: CurrentUser, id: number, input: { invoiceNumber?: unknown }) => withTx(prisma, (tx) => issueInvoiceTx(tx, user, id, input)),
  red: (user: CurrentUser, id: number, input: { redNumber?: unknown; reason: unknown }) => withTx(prisma, (tx) => redInvoiceTx(tx, user, id, input)),
  delivered: (user: CurrentUser, id: number) => withTx(prisma, (tx) => markDeliveredTx(tx, user, id)),
};

// ---------- 国补联动 ----------

/** 这张销售单已开票的发票号码（国补单提交审核时自动带出） */
export async function issuedInvoiceNumber(db: Db, salesOrderId: number): Promise<string | null> {
  const invoice = await db.invoice.findFirst({ where: { salesOrderId, status: "ISSUED" }, orderBy: { id: "desc" }, select: { invoiceNumber: true } });
  return invoice?.invoiceNumber ?? null;
}

// ---------- 查询 ----------

export const INVOICE_PAGE_SIZE = 20;

export interface InvoiceQuery {
  status?: InvoiceStatus;
  storeId?: number;
  month?: string;
  q?: string;
  page?: number;
}

function invoiceWhere(user: CurrentUser, query: InvoiceQuery): Prisma.InvoiceWhereInput {
  const q = (query.q ?? "").trim();
  const range = query.month && /^\d{4}-\d{2}$/.test(query.month) ? monthRange(query.month) : null;
  return {
    AND: [
      storeScopeWhere(user),
      query.storeId ? { storeId: query.storeId } : {},
      query.status ? { status: query.status } : {},
      range ? { createdAt: { gte: new Date(range.from.getTime() - 8 * 3600000), lt: new Date(range.to.getTime() - 8 * 3600000) } } : {},
      q ? { OR: [{ requestNo: { contains: q, mode: "insensitive" } }, { invoiceNumber: { contains: q } }, { titleName: { contains: q } }, { salesOrder: { orderNo: { contains: q, mode: "insensitive" } } }] } : {},
    ],
  };
}

/** 发票列表：店员店长本店，区域经理辖区（只读），总部全部 */
export async function listInvoices(user: CurrentUser, query: InvoiceQuery) {
  const page = clampPage(query.page);
  const where = invoiceWhere(user, query);
  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * INVOICE_PAGE_SIZE,
      take: INVOICE_PAGE_SIZE,
      include: { store: { select: { code: true, name: true } }, salesOrder: { select: { id: true, orderNo: true } }, requestedBy: { select: { name: true } } },
    }),
    prisma.invoice.count({ where }),
  ]);
  return {
    rows,
    total,
    page,
    pageSize: INVOICE_PAGE_SIZE,
    can: { manage: canManageInvoice(user.role), delivered: canMarkInvoiceDelivered(user.role), simulate: isDemo() && canManageInvoice(user.role), userId: user.id, role: user.role },
  };
}

export type InvoiceRow = Awaited<ReturnType<typeof listInvoices>>["rows"][number];

/** 汇总：按门店看待开票、本月开票张数金额、需红冲、电子票占比（九机“发票占比统计”） */
export async function invoiceSummary(user: CurrentUser, query: { storeId?: number }) {
  const { from, to } = monthRange(todayBizDate().toISOString().slice(0, 7));
  const rows = await prisma.invoice.findMany({
    where: { AND: [storeScopeWhere(user), query.storeId ? { storeId: query.storeId } : {}] },
    select: { status: true, kind: true, amountFen: true, issuedAt: true, store: { select: { id: true, code: true, name: true } } },
  });
  type Agg = { storeId: number; label: string; pending: number; monthCount: number; monthFen: number; redPending: number; electronic: number; paper: number };
  const byStore = new Map<number, Agg>();
  const monthFrom = new Date(from.getTime() - 8 * 3600000);
  const monthTo = new Date(to.getTime() - 8 * 3600000);
  for (const r of rows) {
    const a = byStore.get(r.store.id) ?? { storeId: r.store.id, label: `${r.store.code} ${r.store.name}`, pending: 0, monthCount: 0, monthFen: 0, redPending: 0, electronic: 0, paper: 0 };
    if (r.status === "REQUESTED") a.pending++;
    if (r.status === "RED_PENDING") a.redPending++;
    if (r.issuedAt && r.issuedAt >= monthFrom && r.issuedAt < monthTo) {
      a.monthCount++;
      a.monthFen += r.amountFen;
    }
    if (r.issuedAt) {
      if (r.kind === "PAPER_NORMAL") a.paper++;
      else a.electronic++;
    }
    byStore.set(r.store.id, a);
  }
  const stores = Array.from(byStore.values()).sort((x, y) => y.monthFen - x.monthFen);
  const sum = (k: keyof Omit<Agg, "storeId" | "label">) => stores.reduce((s, a) => s + a[k], 0);
  return { stores, total: { pending: sum("pending"), monthCount: sum("monthCount"), monthFen: sum("monthFen"), redPending: sum("redPending"), electronic: sum("electronic"), paper: sum("paper") } };
}

export async function getInvoice(user: CurrentUser, id: number) {
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, code: true, name: true, regionId: true } },
      salesOrder: { select: { id: true, orderNo: true, bizDate: true, salespersonId: true, store: { select: { id: true, regionId: true } } } },
      customer: { select: { id: true, name: true } },
      requestedBy: { select: { name: true } },
      issuedBy: { select: { name: true } },
      redBy: { select: { name: true } },
      lines: { orderBy: { id: "asc" } },
    },
  });
  if (!invoice) return null;
  wrapAccess(() => assertStoreAccess(user, invoice.store));
  return {
    ...invoice,
    salesOrder: { id: invoice.salesOrder.id, orderNo: invoice.salesOrder.orderNo, bizDate: invoice.salesOrder.bizDate, canOpen: canAccessStoreSafe(user, invoice.salesOrder.store) && (user.role !== "STAFF" || invoice.salesOrder.salespersonId === user.id) },
    can: {
      cancel: invoice.status === "REQUESTED" && (invoice.requestedById === user.id || user.role === "STORE_MANAGER" || user.role === "HQ"),
      issue: invoice.status === "REQUESTED" && canManageInvoice(user.role),
      red: (invoice.status === "ISSUED" || invoice.status === "RED_PENDING") && canManageInvoice(user.role),
      delivered: invoice.kind === "PAPER_NORMAL" && invoice.status === "ISSUED" && !invoice.deliveredAt && canMarkInvoiceDelivered(user.role),
      simulate: isDemo(),
    },
  };
}

export type InvoiceDetail = NonNullable<Awaited<ReturnType<typeof getInvoice>>>;

/** 销售单详情里的发票 */
export async function invoicesForOrder(salesOrderId: number) {
  return prisma.invoice.findMany({ where: { salesOrderId }, orderBy: { id: "asc" }, select: { id: true, requestNo: true, kind: true, status: true, titleName: true, amountFen: true, invoiceNumber: true } });
}
