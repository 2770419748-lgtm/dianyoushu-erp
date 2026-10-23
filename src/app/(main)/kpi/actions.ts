"use server";

import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/server/license/license-service";
import { PermissionError } from "@/server/auth/scope";
import { KpiError, saveKpiTargets, type KpiTargetInput } from "@/server/kpi/kpi-service";

export type KpiActionResult = { ok: true; saved: number } | { ok: false; error: string };

export async function saveKpiTargetsAction(year: number, month: number, rows: KpiTargetInput[]): Promise<KpiActionResult> {
  const user = await requireWritableUser();
  try {
    const result = await saveKpiTargets(user, year, month, rows);
    revalidatePath("/kpi");
    revalidatePath("/dashboard");
    return { ok: true, saved: result.saved };
  } catch (error) {
    if (error instanceof KpiError || error instanceof PermissionError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "保存失败，请稍后再试" };
  }
}
