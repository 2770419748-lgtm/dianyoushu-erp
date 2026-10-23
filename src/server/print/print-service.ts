import "server-only";
import { prisma } from "@/lib/prisma";
import { warrantyEndsOn } from "@/lib/entitlement";
import { formatDate } from "@/lib/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/sales-labels";
import type { CurrentUser } from "@/server/auth/current-user";
import { getSalesOrder } from "@/server/sales/sales-service";
import { getCompany } from "@/server/settings/settings-service";

// 小票和保修卡（口径第 23 节）：把一张销售单整理成打印要的样子。权限和看单一样（getSalesOrder 里查门店范围、店员只看自己的单）。
// 客户只给姓名和打码手机号；成本不出现在打印数据里。

export interface PrintHeader {
  title: string; // 小票抬头：系统设置里的，没有用公司名，都没有写“店有数”
  storeName: string;
  storeAddress: string | null;
  phone: string | null;
}

export interface ReceiptLine {
  name: string;
  code: string | null; // 大件的主码
  qty: number;
  unitPriceFen: number;
  lineTotalFen: number;
  service: { covers: string | null; startedOn: string; expiresOn: string; status: "ACTIVE" | "VOIDED" | "CLAIMED" } | null;
}

export interface ReceiptData {
  header: PrintHeader;
  orderNo: string;
  bizDate: string;
  createdAt: Date;
  salesperson: string;
  customer: { name: string; phoneMasked: string } | null;
  voided: boolean;
  lines: ReceiptLine[];
  subtotalFen: number;
  discountFen: number;
  totalFen: number;
  payments: { label: string; amountFen: number }[];
  returns: { orderNo: string; refundFen: number }[];
  warrantyUntil: string | null; // 有机器才有：开单营业日起 12 个月
}

export interface WarrantyCard {
  model: string;
  codes: { label: string; value: string }[];
  services: { name: string; startedOn: string; expiresOn: string; status: "ACTIVE" | "CLAIMED" }[];
}

export interface WarrantyData {
  header: PrintHeader;
  orderNo: string;
  purchasedOn: string;
  warrantyUntil: string;
  customer: { name: string; phoneMasked: string } | null;
  voided: boolean;
  cards: WarrantyCard[];
}

async function header(storeId: number): Promise<PrintHeader> {
  const [company, store] = await Promise.all([getCompany(), prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { name: true, address: true } })]);
  return { title: company?.receiptTitle || company?.name || "店有数", storeName: store.name, storeAddress: store.address, phone: company?.phone ?? null };
}

/** 小票：没有这张单返回 null；没权限抛 PermissionError（和看单一样） */
export async function getReceiptData(user: CurrentUser, orderId: number): Promise<ReceiptData | null> {
  const order = await getSalesOrder(user, orderId);
  if (!order) return null;
  const hasDevice = order.items.some((i) => i.deviceId !== null);
  return {
    header: await header(order.storeId),
    orderNo: order.orderNo,
    bizDate: formatDate(order.bizDate),
    createdAt: order.createdAt,
    salesperson: order.salesperson.name,
    customer: order.customer ? { name: order.customer.name, phoneMasked: order.customer.phoneMasked } : null,
    voided: order.status === "VOIDED",
    lines: order.items.map((i) => ({
      name: i.sku.name,
      code: i.device?.code ?? null,
      qty: i.qty,
      unitPriceFen: i.unitPriceFen,
      lineTotalFen: i.lineTotalFen,
      service: i.entitlement
        ? { covers: i.entitlement.device?.code ?? null, startedOn: formatDate(i.entitlement.startedOn), expiresOn: formatDate(i.entitlement.expiresOn), status: i.entitlement.status }
        : null,
    })),
    subtotalFen: order.subtotalFen,
    discountFen: order.discountFen,
    totalFen: order.totalFen,
    payments: order.payments.map((p) => ({ label: PAYMENT_METHOD_LABELS[p.method], amountFen: p.amountFen })),
    returns: order.returnOrders.map((r) => ({ orderNo: r.orderNo, refundFen: r.refundFen })),
    warrantyUntil: hasDevice ? formatDate(warrantyEndsOn(order.bizDate)) : null,
  };
}

/** 保修卡：一台机器一张；作废的单、已经退货的机器不出卡（cards 为空，页面说明为什么） */
export async function getWarrantyData(user: CurrentUser, orderId: number): Promise<WarrantyData | null> {
  const order = await getSalesOrder(user, orderId);
  if (!order) return null;
  const deviceItems = order.items.filter((i) => i.deviceId !== null && i.returnedQty < i.qty);
  const devices = await prisma.device.findMany({
    where: { id: { in: deviceItems.map((i) => i.deviceId!) } },
    select: { id: true, code: true, sn: true, imei1: true, imei2: true },
  });
  const byId = new Map(devices.map((d) => [d.id, d]));
  const services = order.items.filter((i) => i.entitlement && i.entitlement.status !== "VOIDED");
  const cards: WarrantyCard[] =
    order.status === "VOIDED"
      ? []
      : deviceItems.map((i) => {
          const d = byId.get(i.deviceId!)!;
          return {
            model: i.sku.name,
            codes: [
              ...(d.imei1 ? [{ label: "IMEI1", value: d.imei1 }] : []),
              ...(d.imei2 ? [{ label: "IMEI2", value: d.imei2 }] : []),
              ...(d.sn ? [{ label: "SN", value: d.sn }] : []),
            ],
            // 保这台机器的，和同一张单里没指定机器的（按客户算，第 12 节）；机器退回来了的服务不算这台的
            services: services
              .filter((s) => !s.entitlement!.deviceReturnedAt && (s.entitlement!.device?.code === d.code || s.entitlement!.device === null))
              .map((s) => ({ name: s.sku.name, startedOn: formatDate(s.entitlement!.startedOn), expiresOn: formatDate(s.entitlement!.expiresOn), status: s.entitlement!.status as "ACTIVE" | "CLAIMED" })),
          };
        });
  return {
    header: await header(order.storeId),
    orderNo: order.orderNo,
    purchasedOn: formatDate(order.bizDate),
    warrantyUntil: formatDate(warrantyEndsOn(order.bizDate)),
    customer: order.customer ? { name: order.customer.name, phoneMasked: order.customer.phoneMasked } : null,
    voided: order.status === "VOIDED",
    cards,
  };
}
