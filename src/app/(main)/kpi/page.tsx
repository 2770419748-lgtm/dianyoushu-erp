import { NoAccess } from "@/components/no-access";
import { formatDate } from "@/lib/format";
import { requireUser } from "@/server/auth/current-user";
import { canManageKpi } from "@/server/auth/permissions";
import { listKpiTargets } from "@/server/kpi/kpi-service";
import { KpiView } from "./kpi-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** 当月前后各几个月，给月份下拉用（北京时间） */
function monthOptions(current: string): string[] {
  const [y, m] = current.split("-").map(Number) as [number, number];
  const list: string[] = [];
  for (let offset = -3; offset <= 2; offset++) {
    const d = new Date(Date.UTC(y, m - 1 + offset, 1));
    list.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return list;
}

// KPI 目标录入：总部按月给每家门店定四个数，看板的完成率和"每天还差多少"从这里取。
export default async function KpiPage({ searchParams }: PageProps<"/kpi">) {
  const user = await requireUser();
  if (!canManageKpi(user.role)) return <NoAccess />;
  const current = formatDate(new Date()).slice(0, 7);
  const options = monthOptions(current);
  const requested = one((await searchParams).month);
  const month = options.includes(requested) ? requested : current;
  const [y, m] = month.split("-").map(Number) as [number, number];
  const rows = await listKpiTargets(y, m);
  return <KpiView key={month} month={month} currentMonth={current} options={options} rows={rows} />;
}
