import type { Role } from "@/generated/prisma/enums";
import { DEMO_MODE } from "./demo-accounts";

// 二次验证的规矩（口径第 20 节），单独放一个小文件：登录校验、会话核对（session-user）、二次验证服务都要用，
// 免得会话核对去引用带 cookies、二维码的整个二次验证服务。

/** 哪些角色要二次验证：店长及以上 */
export function mfaRequiredFor(role: Role): boolean {
  return role !== "STAFF";
}

/** 是不是强制：真用时强制，演示模式只对自己开了的人要 */
export function mfaEnforced(): boolean {
  return !DEMO_MODE;
}

/** 这个账号现在必须先绑二次验证才能用（真用时店长及以上没绑的）：会话核对、登录第二步都按它判断 */
export function needsMfaBinding(role: Role, mfaEnabledAt: Date | null, enforced = mfaEnforced()): boolean {
  return enforced && mfaRequiredFor(role) && !mfaEnabledAt;
}
