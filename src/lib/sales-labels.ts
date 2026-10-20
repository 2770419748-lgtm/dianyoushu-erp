import type { PaymentMethod, SalesOrderStatus } from "@/generated/prisma/enums";

// 销售相关枚举的中文说明和脱敏工具。纯数据，客户端服务端都能用。

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "现金",
  WECHAT: "微信",
  ALIPAY: "支付宝",
  CARD: "刷卡",
  INSTALLMENT: "分期",
  TRADE_IN: "以旧换新抵扣",
  OTHER: "其他",
  SUBSIDY: "国补立减",
};

/** 开单时能直接选的收款方式（以旧换新抵扣要关联回收单，第 7 周做） */
export const PAYMENT_METHODS_FOR_SALE: PaymentMethod[] = ["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER"];

export const SALES_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  COMPLETED: "已完成",
  VOIDED: "已作废",
};

export const SALES_STATUS_COLORS: Record<SalesOrderStatus, string> = {
  COMPLETED: "green",
  VOIDED: "red",
};

/** 手机号脱敏：138****1234 */
export function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}
