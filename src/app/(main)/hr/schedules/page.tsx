import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canViewTeamAttendance } from "@/server/auth/permissions";
import { getWeekSchedule, ScheduleError } from "@/server/hr/schedule-service";
import { SchedulesView } from "./schedules-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 排班（口径第 19 节）：一周一屏，店长排本店、总部排全部，区域经理只看；可以复制上周。
export default async function SchedulesPage({ searchParams }: PageProps<"/hr/schedules">) {
  const user = await requireUser();
  if (!canViewTeamAttendance(user.role)) return <NoAccess title="排班表店长、区域经理和总部能看" subTitle="自己的班在“考勤打卡”里看。" />;
  const params = await searchParams;
  let data;
  try {
    data = await getWeekSchedule(user, { storeId: Number(one(params.store)) || undefined, week: one(params.week) || undefined });
  } catch (error) {
    if (error instanceof ScheduleError) return <NoAccess subTitle={error.message} />;
    throw error;
  }
  return <SchedulesView data={data} />;
}
