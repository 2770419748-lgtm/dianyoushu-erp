import { bjDateKey } from "@/lib/attendance";
import type { ExpenseStatusKey } from "@/lib/expense";
import { isDbId } from "@/lib/paging";
import { requireUser } from "@/server/auth/current-user";
import { listExpenses, type ExpenseView } from "@/server/finance/expense-service";
import { ExpensesView } from "./expenses-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const STATUSES: ExpenseStatusKey[] = ["PENDING", "APPROVED", "PAID", "REJECTED", "CANCELLED"];

// 费用报销（口径第 19 节）：每个人提交、撤回自己的；店长看本店、区域经理看辖区、总部看全部；总部登记付款；审批在“审批”里批。
export default async function ExpensesPage({ searchParams }: PageProps<"/finance/expenses">) {
  const user = await requireUser();
  const params = await searchParams;
  const status = STATUSES.find((s) => s === one(params.status));
  const store = Number(one(params.store));
  const data = await listExpenses(user, { view: one(params.view) as ExpenseView, month: one(params.month) || undefined, status, storeId: isDbId(store) ? store : undefined, page: Number(one(params.page)) || 1 });
  return <ExpensesView data={data} status={status} month={one(params.month) || null} today={bjDateKey(new Date())} role={user.role} />;
}
