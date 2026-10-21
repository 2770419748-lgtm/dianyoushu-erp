// 费用报销（口径第 19 节）：类型、状态的名字，要几级批。纯函数，服务层、页面、演示数据生成、单元测试共用（tests/expense.test.ts）。

export type ExpenseCategoryKey = "TRANSPORT" | "OFFICE" | "REPAIR_PARTS" | "ENTERTAINMENT" | "LOGISTICS" | "OTHER";
export type ExpenseStatusKey = "PENDING" | "APPROVED" | "PAID" | "REJECTED" | "CANCELLED";
export type ExpensePayMethodKey = "CASH" | "BANK" | "WECHAT" | "ALIPAY";
type RoleKey = "STAFF" | "STORE_MANAGER" | "REGIONAL_MANAGER" | "HQ";

export const EXPENSE_CATEGORIES: ExpenseCategoryKey[] = ["TRANSPORT", "OFFICE", "REPAIR_PARTS", "ENTERTAINMENT", "LOGISTICS", "OTHER"];
export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategoryKey, string> = { TRANSPORT: "交通", OFFICE: "办公用品", REPAIR_PARTS: "维修耗材", ENTERTAINMENT: "招待", LOGISTICS: "快递物流", OTHER: "其他" };
export const EXPENSE_STATUS_LABELS: Record<ExpenseStatusKey, string> = { PENDING: "审批中", APPROVED: "待付款", PAID: "已付款", REJECTED: "驳回", CANCELLED: "撤回" };
export const EXPENSE_STATUS_COLORS: Record<ExpenseStatusKey, string> = { PENDING: "blue", APPROVED: "orange", PAID: "green", REJECTED: "red", CANCELLED: "default" };
export const EXPENSE_PAY_METHODS: ExpensePayMethodKey[] = ["BANK", "WECHAT", "ALIPAY", "CASH"];
export const EXPENSE_PAY_METHOD_LABELS: Record<ExpensePayMethodKey, string> = { CASH: "现金", BANK: "银行转账", WECHAT: "微信", ALIPAY: "支付宝" };

/** 多少钱（含）以上要总部再批：2000 元 */
export const EXPENSE_HQ_FEN = 200000;
/** 一张最多报多少：5 万元（数据库 CHECK 也拦） */
export const EXPENSE_MAX_FEN = 5000000;
/** 最多报多少天以前发生的：90 天 */
export const EXPENSE_BACKDATE_DAYS = 90;

/**
 * 报销要几级批：门店的店员 2000 元以下店长批，2000 元及以上店长批完总部再批；
 * 店长自己的（不能批自己的）、区域经理和总部的人直接总部批。
 */
export function expenseChain(role: RoleKey, hasStore: boolean, amountFen: number): ("STORE_MANAGER" | "HQ")[] {
  if (role === "STAFF" && hasStore) return amountFen >= EXPENSE_HQ_FEN ? ["STORE_MANAGER", "HQ"] : ["STORE_MANAGER"];
  return ["HQ"];
}
