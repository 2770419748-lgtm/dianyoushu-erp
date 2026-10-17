import "server-only";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import { isProtectedDemoAccount } from "./demo-accounts";
import { verifyPassword } from "./password";
import { loginLimiter } from "./rate-limit";

// 登录校验（页面的 Server Function 只调这里）。
//
// 限流按用户名算，不按 IP：
// - 没有反向代理时 X-Forwarded-For 谁都能伪造，按“用户名 + IP”锁，换个头就绕过去了；
// - 不带这个头时所有人都算成同一个 IP，同一个 Wi-Fi 里有人把 manager 输错 5 次，大家一起被锁。
// 代价：别人可以故意输错 5 次把某个账号锁 15 分钟，演示版接受（取舍记录里写了）。
// 4 个公共演示账号不限流：密码本来就是公开的，限流防不了什么，反而会被路过的人锁住。
// IP 只记进操作日志，方便事后查。

export type LoginResult = { ok: true; userId: number } | { ok: false; error: string };

export async function authenticate(usernameInput: string, password: string, ip: string): Promise<LoginResult> {
  const username = usernameInput.trim();
  if (!username || !password) return { ok: false, error: "请输入账号和密码" };

  const limited = !isProtectedDemoAccount(username.toLowerCase());
  const key = `login:${username.toLowerCase()}`;
  if (limited) {
    const gate = loginLimiter.check(key);
    if (!gate.allowed) {
      const minutes = Math.max(1, Math.ceil(gate.retryAfterMs / 60000));
      return { ok: false, error: `这个账号错误次数太多，请 ${minutes} 分钟后再试` };
    }
  }

  const user = await prisma.user.findUnique({ where: { username } });
  const ok = user !== null && user.isActive && (await verifyPassword(password, user.passwordHash));
  if (!ok) {
    if (limited) loginLimiter.recordFailure(key);
    await writeAudit({ userId: user?.id ?? null, action: "login_failed", detail: { username }, ip });
    return { ok: false, error: "账号或密码不对" };
  }

  if (limited) loginLimiter.reset(key);
  await writeAudit({ userId: user.id, action: "login", ip });
  return { ok: true, userId: user.id };
}
