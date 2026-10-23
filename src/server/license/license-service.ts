import "server-only";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { isWritable, licenseState, type LicenseState } from "@/lib/license";
import { bjDateKey } from "@/lib/attendance";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { getLicense } from "@/server/settings/settings-service";
import type { Db } from "@/server/db-tx";

// 试用和到期（口径第 21 节）：现在处在哪个阶段；过了宽限期只读——所有改数据的服务端动作开头用 requireWritableUser，
// 只读时跳到“服务已到期”页。改自己的密码、二次验证、退出、看消息不受限（那几个动作还用 requireUser）。

export async function currentLicenseState(db: Db = prisma, now = new Date()): Promise<LicenseState> {
  if (DEMO_MODE) return { kind: "demo" };
  return licenseState(await getLicense(db), bjDateKey(now), false);
}

/**
 * 改数据的服务端动作用：要登录、要还能改数据；第一次登录还没改初始密码的也先去改。
 * 不能改时直接跳页（Server Function 里的 redirect 会让页面跳过去），不往下执行。
 */
export async function requireWritableUser(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/");
  if (!isWritable(await currentLicenseState())) redirect("/expired");
  return user;
}
