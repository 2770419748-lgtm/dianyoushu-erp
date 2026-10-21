import { requireUser } from "@/server/auth/current-user";
import { getPayrollPage } from "@/server/hr/payroll-service";
import { PayrollView } from "./payroll-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 提成和工资条（口径第 19 节）：总部选月份生成、改奖惩、发布、整月作废，配提成方案；其他人只看自己已发布的工资条。
export default async function PayrollPage({ searchParams }: PageProps<"/hr/payroll">) {
  const user = await requireUser();
  const params = await searchParams;
  const data = await getPayrollPage(user, { month: one(params.month) || undefined });
  return <PayrollView data={data} />;
}
