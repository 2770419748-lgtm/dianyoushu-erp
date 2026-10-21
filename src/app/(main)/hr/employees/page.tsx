import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canViewEmployees } from "@/server/auth/permissions";
import { listEmployees } from "@/server/hr/employee-service";
import { EmployeesView } from "./employees-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 员工档案（口径第 19 节）：店长本店、区域经理辖区（都不看工资），总部全部、能改。
export default async function EmployeesPage({ searchParams }: PageProps<"/hr/employees">) {
  const user = await requireUser();
  if (!canViewEmployees(user.role)) return <NoAccess title="员工档案店长、区域经理和总部能看" />;
  const params = await searchParams;
  const data = await listEmployees(user, { q: one(params.q) || undefined, includeInactive: one(params.all) === "1" });
  return <EmployeesView data={data} q={one(params.q)} includeInactive={one(params.all) === "1"} />;
}
