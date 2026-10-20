import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { canSell } from "@/server/auth/permissions";
import { assertStoreAccess, PermissionError } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { DeviceStateError } from "@/server/stock/device-state";
import { nextDocNo, todayBizDate } from "@/server/stock/doc-no";
import { applyDeviceAction, changeAccessoryStock, StockError } from "@/server/stock/stock-service";
import { voidEntitlementsTx } from "@/server/entitlement/entitlement-service";
import { cancelClaimsTx } from "@/server/subsidy/subsidy-service";
import { maxRefundableFen, MANUAL_PAYMENT_METHODS, returnRefundCapFen } from "./payments";
import { lockRow } from "@/server/db-lock";
import { DAY_CLOSED_MESSAGE, isDayClosed, lockStoreDay } from "@/server/dailyclose/guard";

// 退货（口径第 5、6 节）：选原销售单的明细退回 → 串号回在库（回收机回良品）、配件加回数量；
// 退款记负数、记在原单用过的一种收款方式上；以旧换新抵扣部分不退，只退实付。退货单不作废，退错了再开一单。

export class ReturnError extends Error {}

type Tx = Prisma.TransactionClient;

export interface ReturnInput {
  salesOrderId: unknown;
  lines: { salesItemId: unknown; qty: unknown }[];
  refundFen: unknown;
  refundMethod: unknown;
  reason?: unknown;
}

/** 退货页要用的数据：原单明细、每行还能退几件、默认退款、能用的退款方式 */
export async function getReturnContext(user: CurrentUser, salesOrderId: number) {
  const order = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      store: { select: { id: true, code: true, name: true, regionId: true } },
      items: { orderBy: { id: "asc" }, include: { sku: { select: { name: true } }, device: { select: { code: true } }, entitlement: { select: { deviceId: true, status: true } }, subsidyClaim: { select: { subsidyFen: true } } } },
      payments: true,
      returnOrders: { select: { refundFen: true } },
    },
  });
  if (!order) return null;
  assertStoreAccess(user, order.store);
  if (user.role === "STAFF" && order.salespersonId !== user.id) throw new PermissionError("店员只能给自己开的单退货");
  const refunded = order.returnOrders.reduce((s, r) => s + r.refundFen, 0);
  const salePayments = order.payments.filter((p) => p.salesOrderId === order.id && p.amountFen > 0);
  return {
    order: { id: order.id, orderNo: order.orderNo, status: order.status, subtotalFen: order.subtotalFen, totalFen: order.totalFen, store: order.store },
    todayClosed: await isDayClosed(prisma, order.storeId, todayBizDate()), // 退货记在今天：今天已日结就不能退
    items: order.items.map((i) => ({
      id: i.id,
      name: i.sku.name,
      deviceCode: i.device?.code ?? null,
      qty: i.qty,
      returnedQty: i.returnedQty,
      returnableQty: i.qty - i.returnedQty,
      lineTotalFen: i.lineTotalFen,
      deviceId: i.deviceId,
      // 服务行（碎屏险、延保）保的是本单哪台机器：退这台机器时提示一起退服务
      serviceForDeviceId: i.entitlement?.status === "ACTIVE" ? i.entitlement.deviceId : null,
      subsidyFen: i.subsidyClaim?.subsidyFen ?? 0, // 这台机器的国补：平台出的，退货不退给顾客
    })),
    refundMethods: Array.from(new Set(salePayments.map((p) => p.method).filter((m) => m !== "TRADE_IN" && m !== "SUBSIDY"))),
    tradeInFen: salePayments.filter((p) => p.method === "TRADE_IN").reduce((s, p) => s + p.amountFen, 0),
    subsidyFen: salePayments.filter((p) => p.method === "SUBSIDY").reduce((s, p) => s + p.amountFen, 0),
    refundedFen: refunded,
    maxRefundFen: maxRefundableFen(salePayments, refunded),
  };
}

export type ReturnContext = NonNullable<Awaited<ReturnType<typeof getReturnContext>>>;

export async function createReturnTx(tx: Tx, user: CurrentUser, input: ReturnInput) {
  if (!canSell(user.role)) throw new ReturnError("你的角色不能退货");
  const salesOrderId = Number(input.salesOrderId);
  const head = await tx.salesOrder.findUnique({ where: { id: salesOrderId }, select: { storeId: true, salespersonId: true, store: { select: { id: true, regionId: true } } } });
  if (!head) throw new ReturnError("原销售单不存在");
  assertStoreAccess(user, head.store);
  if (user.role === "STAFF" && head.salespersonId !== user.id) throw new ReturnError("店员只能给自己开的单退货");
  // 退货记在原单门店的今天：先排队拿锁，再读原单的已退数量（防止同一行被两个人同时退）
  const bizDate = todayBizDate();
  await lockStoreDay(tx, head.storeId, bizDate);
  // 再锁原单这一行：和“作废这张单”排队（作废锁的是原单那天，退货锁的是今天，两把日锁不同，靠这一行的锁错开）
  await lockRow(tx, "sales_orders", salesOrderId);
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: { store: true, items: { include: { sku: { select: { isService: true } }, entitlement: { select: { status: true } }, subsidyClaim: { select: { subsidyFen: true } } } }, payments: true, returnOrders: { select: { refundFen: true } } },
  });
  if (!order) throw new ReturnError("原销售单不存在");
  assertStoreAccess(user, order.store);
  if (order.status !== "COMPLETED") throw new ReturnError("作废的单不能退货");
  if (await isDayClosed(tx, order.storeId, bizDate)) throw new ReturnError(DAY_CLOSED_MESSAGE);

  // 退哪些
  const plans: { item: (typeof order.items)[number]; qty: number }[] = [];
  for (const line of input.lines ?? []) {
    const item = order.items.find((i) => i.id === Number(line.salesItemId));
    if (!item) throw new ReturnError("退货明细不属于原单");
    const qty = Number(line.qty ?? 0);
    if (qty === 0) continue;
    if (!Number.isInteger(qty) || qty < 0) throw new ReturnError("退货数量必须是正整数");
    if (qty > item.qty - item.returnedQty) throw new ReturnError(`这一行最多还能退 ${item.qty - item.returnedQty} 件`);
    if (qty > 0 && item.entitlement?.status === "CLAIMED") throw new ReturnError("这份碎屏险已经在维修单上理赔过了，不能再退");
    plans.push({ item, qty });
  }
  if (plans.length === 0) throw new ReturnError("没选要退的商品");

  // 退多少钱、退到哪
  const refundFen = Number(input.refundFen);
  if (!Number.isInteger(refundFen) || refundFen < 0) throw new ReturnError("退款金额不对");
  const salePayments = order.payments.filter((p) => p.salesOrderId === order.id && p.amountFen > 0);
  const refunded = order.returnOrders.reduce((s, r) => s + r.refundFen, 0);
  const maxFen = returnRefundCapFen(
    plans.map((p) => ({ lineTotalFen: p.item.lineTotalFen, qty: p.item.qty, returnQty: p.qty, subsidyFen: p.item.subsidyClaim?.subsidyFen ?? 0 })),
    order,
    salePayments,
    refunded,
  );
  if (refundFen > maxFen) {
    const paidLeft = maxRefundableFen(salePayments, refunded);
    const hasSubsidy = plans.some((p) => p.item.subsidyClaim);
    throw new ReturnError(`这次退回的商品最多退 ${(maxFen / 100).toFixed(2)} 元${maxFen === paidLeft ? "（以旧换新抵扣、国补立减部分不退）" : hasSubsidy ? "（按退回的商品成交额减去国补算）" : "（按退回的商品成交额算）"}`);
  }
  const refundMethod = input.refundMethod as PaymentMethod;
  if (refundFen > 0) {
    if (!MANUAL_PAYMENT_METHODS.includes(refundMethod)) throw new ReturnError("请选退款方式");
    if (!salePayments.some((p) => p.method === refundMethod)) throw new ReturnError("退款要走原单用过的收款方式");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 200) || null : null;

  const orderNo = await nextDocNo(tx, "RT");
  const created = await tx.returnOrder.create({
    data: {
      orderNo,
      storeId: order.storeId,
      salesOrderId: order.id,
      customerId: order.customerId,
      handledById: user.id,
      bizDate,
      refundFen,
      reason,
      items: {
        create: plans.map((p) => ({
          salesItemId: p.item.id,
          skuId: p.item.skuId,
          deviceId: p.item.deviceId,
          qty: p.qty,
          // 每行退款按成交额占比分摊，最后一行补差，合计等于 refundFen
          refundFen: 0,
        })),
      },
      payments: refundFen > 0 ? { create: [{ method: refundMethod, amountFen: -refundFen }] } : undefined,
    },
    include: { items: true },
  });

  // 每行退款分摊（展示用；对账以 payments 为准）
  const base = plans.reduce((s, p) => s + Math.round((p.item.lineTotalFen * p.qty) / p.item.qty), 0);
  let remaining = refundFen;
  for (const [index, line] of created.items.entries()) {
    const plan = plans[index]!;
    const share = index === created.items.length - 1 ? remaining : base > 0 ? Math.round((refundFen * Math.round((plan.item.lineTotalFen * plan.qty) / plan.item.qty)) / base) : 0;
    remaining -= share;
    await tx.returnOrderItem.update({ where: { id: line.id }, data: { refundFen: share } });
  }

  try {
    for (const plan of plans) {
      if (plan.item.deviceId) {
        await applyDeviceAction(tx, { deviceId: plan.item.deviceId, action: "RETURN", docType: "RETURN", docNo: orderNo, operatorId: user.id, note: reason ?? undefined });
      } else if (!plan.item.sku.isService) {
        await changeAccessoryStock(tx, { storeId: order.storeId, skuId: plan.item.skuId, qtyDelta: plan.qty, docType: "RETURN", docNo: orderNo, operatorId: user.id, note: reason ?? undefined });
      }
      await tx.salesOrderItem.update({ where: { id: plan.item.id }, data: { returnedQty: { increment: plan.qty } } });
      // 退掉的是服务（一行一份，退了就是全退）：这份碎屏险、延保失效
      if (plan.item.sku.isService) await voidEntitlementsTx(tx, { salesOrderItemIds: [plan.item.id] });
    }
    // 退了机器、保它的服务没退：服务照常有效，但记上“机器已退回”。机器回库后可能再卖给别人，不能一台机器挂两个客户的保障
    // 退了补贴的机器：国补单没到账的撤销，已到账的标“需退回”（口径第 15 节）
    const subsidizedItems = plans.filter((p) => p.item.subsidyClaim).map((p) => p.item.id);
    if (subsidizedItems.length > 0) await cancelClaimsTx(tx, { salesOrderItemIds: subsidizedItems });
    const returnedDevices = plans.map((p) => p.item.deviceId).filter((id): id is number => id !== null);
    if (returnedDevices.length > 0) {
      await tx.serviceEntitlement.updateMany({ where: { salesOrderId: order.id, deviceId: { in: returnedDevices }, status: "ACTIVE", deviceReturnedAt: null }, data: { deviceReturnedAt: new Date() } });
    }
  } catch (error) {
    if (error instanceof StockError || error instanceof DeviceStateError) throw new ReturnError(error.message);
    throw error;
  }

  await writeAudit({ userId: user.id, action: "return.create", entity: "return_order", entityId: created.id, detail: { orderNo, salesOrderNo: order.orderNo, refundFen, lines: plans.length } }, tx);
  return { id: created.id, orderNo };
}

export async function createReturn(user: CurrentUser, input: ReturnInput) {
  return prisma.$transaction((tx) => createReturnTx(tx, user, input));
}
