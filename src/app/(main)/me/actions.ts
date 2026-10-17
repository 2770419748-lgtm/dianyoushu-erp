"use server";

import { requireUser } from "@/server/auth/current-user";
import { AccountError, changeOwnPassword } from "@/server/auth/account-service";

export type AccountActionResult = { ok: true } | { ok: false; error: string };

export async function changePasswordAction(oldPassword: string, newPassword: string): Promise<AccountActionResult> {
  const user = await requireUser();
  try {
    await changeOwnPassword(user, oldPassword, newPassword);
    return { ok: true };
  } catch (error) {
    if (error instanceof AccountError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "改密码失败，请稍后再试" };
  }
}
