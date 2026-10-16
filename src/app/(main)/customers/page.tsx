import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canSell } from "@/server/auth/permissions";
import { searchCustomers } from "@/server/customers/customer-service";
import { CustomersView } from "./customers-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 客户列表：按手机号或姓名搜，手机号脱敏；店员、店长、总部能用。
export default async function CustomersPage({ searchParams }: PageProps<"/customers">) {
  const user = await requireUser();
  if (!canSell(user.role)) return <NoAccess />;
  const params = await searchParams;
  const q = one(params.q);
  const data = await searchCustomers(user, q, Number(one(params.page)) || 1);
  return <CustomersView rows={data.rows} total={data.total} page={data.page} pageSize={data.pageSize} q={q} />;
}
