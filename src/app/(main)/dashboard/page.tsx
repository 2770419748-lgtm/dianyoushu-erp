import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { getDashboard } from "@/server/dashboard/dashboard-service";
import { DashboardView } from "./dashboard-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 经营看板：店长本店、区域经理辖区、总部全部；可以选单家门店看。
export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const user = await requireUser();
  if (user.role === "STAFF") return <NoAccess title="看板给店长、区域经理和总部看" />;
  const params = await searchParams;
  const storeId = Number(one(params.storeId)) || undefined;
  const data = await getDashboard(user, storeId);
  if (!data) return <NoAccess title="你没有可看的门店" />;
  return <DashboardView data={data} storeId={storeId} />;
}
