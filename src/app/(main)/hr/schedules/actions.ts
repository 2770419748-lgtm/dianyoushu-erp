"use server";

import { revalidatePath } from "next/cache";
import type { ShiftKindKey } from "@/lib/attendance";
import { requireUser } from "@/server/auth/current-user";
import { copyLastWeek, saveSchedule, ScheduleError } from "@/server/hr/schedule-service";

// 排班（口径第 19 节）：店长排本店、总部排全部；规则都在服务层。

export type ScheduleActionResult = { ok: true; message: string } | { ok: false; error: string };

async function run(fn: () => Promise<string>): Promise<ScheduleActionResult> {
  try {
    const message = await fn();
    revalidatePath("/hr/schedules");
    revalidatePath("/hr/attendance");
    return { ok: true, message };
  } catch (error) {
    if (error instanceof ScheduleError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "保存失败，请稍后再试" };
  }
}

export async function saveScheduleAction(storeId: number, cells: { userId: number; date: string; shift: ShiftKindKey | null }[]) {
  const user = await requireUser();
  return run(async () => `已保存 ${await saveSchedule(user, { storeId, cells })} 格`);
}

export async function copyLastWeekAction(storeId: number, week: string) {
  const user = await requireUser();
  return run(async () => `按上周排好了 ${await copyLastWeek(user, { storeId, week })} 格（本周已经排了的没动）`);
}
