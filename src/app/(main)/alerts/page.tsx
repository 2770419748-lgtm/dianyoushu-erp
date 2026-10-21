import { isDbId } from "@/lib/paging";
import { requireUser } from "@/server/auth/current-user";
import { getAlertsPage } from "@/server/alerts/alert-service";
import { AlertsView } from "./alerts-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 智能提醒（口径第 18 节）：今天的今日待办（我能看的范围）、命中的规则明细、立即生成（店长本店、总部全部）。
export default async function AlertsPage({ searchParams }: PageProps<"/alerts">) {
  const user = await requireUser();
  const params = await searchParams;
  const digestId = Number(one(params.digest));
  const data = await getAlertsPage(user, { date: one(params.date) || undefined, digestId: isDbId(digestId) ? digestId : undefined });
  return <AlertsView data={data} />;
}
