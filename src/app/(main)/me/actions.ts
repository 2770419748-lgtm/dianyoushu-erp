"use server";

import { requireUser } from "@/server/auth/current-user";
import { AccountError, changeOwnPassword } from "@/server/auth/account-service";
import { confirmOwnMfaSetup, MfaError, startOwnMfaSetup } from "@/server/auth/mfa-service";
import { createSession } from "@/server/auth/session";

export type AccountActionResult = { ok: true } | { ok: false; error: string };

/** 自己开二次验证：先拿二维码（口径第 20 节） */
export async function startMfaSetupAction(): Promise<{ ok: true; setup: { qr: string; secret: string; sid: string } } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    return { ok: true, setup: await startOwnMfaSetup(user) };
  } catch (error) {
    if (error instanceof MfaError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

/** 输一次动态码确认，才算开启 */
export async function confirmMfaSetupAction(code: string, sid: string): Promise<AccountActionResult> {
  const user = await requireUser();
  try {
    await confirmOwnMfaSetup(user, code, sid);
    return { ok: true };
  } catch (error) {
    if (error instanceof MfaError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function changePasswordAction(oldPassword: string, newPassword: string): Promise<AccountActionResult> {
  const user = await requireUser({ allowFirstPassword: true }); // 第一次登录改初始密码也走这里
  try {
    const sessionVersion = await changeOwnPassword(user, oldPassword, newPassword);
    await createSession(user.id, sessionVersion); // 当前这台继续登录着；别处的旧登录已经失效
    return { ok: true };
  } catch (error) {
    if (error instanceof AccountError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "改密码失败，请稍后再试" };
  }
}
