import { isDbId } from "@/lib/paging";
import { requireUser } from "@/server/auth/current-user";
import { AttendanceError, getMyToday, manualPunchTargets, monthStats, userMonthDetail } from "@/server/hr/attendance-service";
import { AttendanceView } from "./attendance-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 考勤打卡（口径第 19 节）：每个人打自己的上下班卡、看本周的班；月度统计店员只看自己，店长本店、区域经理辖区、总部全部；店长、总部能补卡。
export default async function AttendancePage({ searchParams }: PageProps<"/hr/attendance">) {
  const user = await requireUser();
  const params = await searchParams;
  const storeId = Number(one(params.store)) || undefined;
  const [today, stats, targets] = await Promise.all([getMyToday(user), monthStats(user, { month: one(params.month), storeId }), manualPunchTargets(user)]);
  const requested = Number(one(params.user));
  const detailUserId = isDbId(requested) ? requested : null;
  let detail = null;
  let detailError: string | null = null;
  if (detailUserId) {
    try {
      detail = await userMonthDetail(user, detailUserId, stats.month);
    } catch (error) {
      if (!(error instanceof AttendanceError)) throw error;
      detailError = error.message;
    }
  }
  return (
    <AttendanceView
      today={today}
      stats={stats}
      targets={targets.map((t) => ({ id: t.id, label: `${t.name}${t.store ? `（${t.store.name}）` : ""}` }))}
      detail={detail}
      detailUserId={detailUserId}
      detailError={detailError}
    />
  );
}
