"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import { EmployeeError, saveEmployeeProfile } from "@/server/hr/employee-service";

// 员工档案：总部改。
export async function saveEmployeeAction(userId: number, input: { hireDate?: string; position?: string; phone?: string; baseSalaryFen?: number; leaveDate?: string; note?: string; commissionPlanId?: number | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    await saveEmployeeProfile(user, userId, input);
    revalidatePath("/hr/employees");
    return { ok: true };
  } catch (error) {
    if (error instanceof EmployeeError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "保存失败，请稍后再试" };
  }
}
