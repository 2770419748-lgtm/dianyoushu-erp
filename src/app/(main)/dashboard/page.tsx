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
  const requested = Number(one(params.storeId));
  const storeId = Number.isInteger(requested) && requested > 0 && requested <= 2147483647 ? requested : undefined;
  const data = await getDashboard(user, storeId);
  if (!data) return storeId ? <NoAccess title="没有权限看这家门店" subTitle="这家店不在你能看的范围里。" /> : <NoAccess title="你没有可看的门店" />;
  return <DashboardView data={data} storeId={storeId} />;
}
