"use server";

import { revalidatePath } from "next/cache";
import { ImportError, revokeImport } from "@/server/import/import-service";
import { requireWritableUser } from "@/server/license/license-service";

// 撤销一次导入（口径第 22 节）：规则在服务层。上传、预检、确认导入走 /api/import（文件大）。

export async function revokeImportAction(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireWritableUser();
  try {
    await revokeImport(user, id);
    revalidatePath("/setup/import");
    return { ok: true };
  } catch (error) {
    if (error instanceof ImportError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "撤销失败，请稍后再试" };
  }
}
