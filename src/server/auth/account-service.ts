import "server-only";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import type { CurrentUser } from "./current-user";
import { DEMO_PROTECTED_MESSAGE, isProtectedDemoAccount } from "./demo-accounts";
import { hashPassword, verifyPassword } from "./password";
import { createLoginLimiter } from "./rate-limit";

// 个人信息页：自己改密码。要先输对旧密码；旧密码错 5 次锁 15 分钟（和登录同一套限流规则），防止有人拿着别人没退出的电脑猜密码。

export class AccountError extends Error {}

const limiter = createLoginLimiter();

export async function changeOwnPassword(user: CurrentUser, oldPassword: unknown, newPassword: unknown) {
  if (isProtectedDemoAccount(user.username)) throw new AccountError(DEMO_PROTECTED_MESSAGE);
  const oldText = typeof oldPassword === "string" ? oldPassword : "";
  const newText = typeof newPassword === "string" ? newPassword : "";
  if (newText.length < 6) throw new AccountError("新密码至少 6 位");
  if (newText.length > 72) throw new AccountError("新密码最多 72 位");
  if (newText === oldText) throw new AccountError("新密码不能和旧密码一样");

  const key = `change-password:${user.id}`;
  const check = limiter.check(key);
  if (!check.allowed) throw new AccountError(`旧密码错太多次了，${Math.ceil(check.retryAfterMs / 60000)} 分钟后再试`);

  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!row || !(await verifyPassword(oldText, row.passwordHash))) {
    limiter.recordFailure(key);
    throw new AccountError("旧密码不对");
  }
  limiter.reset(key);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newText) } });
  await writeAudit({ userId: user.id, action: "user.change_password", entity: "user", entityId: user.id });
}
