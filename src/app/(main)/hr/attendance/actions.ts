"use server";

import { revalidatePath } from "next/cache";
import { PUNCH_LABELS, type PunchKindKey } from "@/lib/attendance";
import { requireUser } from "@/server/auth/current-user";
import { addManualPunch, AttendanceError, punch } from "@/server/hr/attendance-service";

// 考勤打卡（口径第 19 节）：员工自己打卡；店长、总部补卡。规则都在服务层。

export type AttendanceActionResult = { ok: true; message: string } | { ok: false; error: string };

async function run(fn: () => Promise<string>): Promise<AttendanceActionResult> {
  try {
    const message = await fn();
    revalidatePath("/hr/attendance");
    revalidatePath("/me");
    return { ok: true, message };
  } catch (error) {
    if (error instanceof AttendanceError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "打卡失败，请稍后再试" };
  }
}

export async function punchAction(kind: PunchKindKey) {
  const user = await requireUser();
  return run(async () => {
    const r = await punch(user, kind);
    return `${PUNCH_LABELS[r.kind]}打卡成功：${r.label}`;
  });
}

export async function manualPunchAction(input: { userId: number; date: string; kind: PunchKindKey; time: string; note: string }) {
  const user = await requireUser();
  return run(async () => {
    const r = await addManualPunch(user, input);
    return `已给${r.name}补录${PUNCH_LABELS[input.kind]}卡`;
  });
}
