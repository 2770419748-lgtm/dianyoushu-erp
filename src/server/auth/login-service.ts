import "server-only";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import { isProtectedDemoAccount } from "./demo-accounts";
import { verifyPassword } from "./password";
import { createLoginLimiter, loginLimiter } from "./rate-limit";

// 登录校验（页面的 Server Function 只调这里）。
//
// 限流分两种情况（TRUST_PROXY 环境变量决定）：
// - 应用直接对外（本机、没有反向代理）：X-Forwarded-For 谁都能伪造，只按用户名锁——错 5 次锁这个账号 15 分钟。
//   代价是别人可以故意输错把某个账号锁住，演示版接受（取舍记录里写了）。
// - 在 Caddy 后面（docker compose 设了 TRUST_PROXY=1）：X-Forwarded-For 由 Caddy 按真实来源写入，可信。
//   这时按“IP + 用户名”锁（别人在自己那台机器上乱试，锁不住真正的员工），
//   另外同一个 IP 15 分钟内不管换哪个账号，累计错 20 次也锁这个 IP（防一个 IP 挨个账号试密码）。
// 4 个公共演示账号在演示模式下不限流：密码本来就是公开的，限流防不了什么，反而会被路过的人锁住。
// IP 同时记进操作日志，方便事后查。

const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const IP_MAX_FAILURES = 20;
const ipLimiter = createLoginLimiter(undefined, IP_MAX_FAILURES);

export type LoginResult = { ok: true; userId: number; sessionVersion: number } | { ok: false; error: string };

export async function authenticate(usernameInput: string, password: string, ip: string): Promise<LoginResult> {
  const username = usernameInput.trim();
  if (!username || !password) return { ok: false, error: "请输入账号和密码" };

  const limited = !isProtectedDemoAccount(username.toLowerCase());
  const byIp = TRUST_PROXY && ip !== "unknown";
  const key = byIp ? `login:${username.toLowerCase()}@${ip}` : `login:${username.toLowerCase()}`;
  const ipKey = `login-ip:${ip}`;
  if (byIp) {
    const ipGate = ipLimiter.check(ipKey);
    if (!ipGate.allowed) {
      const minutes = Math.max(1, Math.ceil(ipGate.retryAfterMs / 60000));
      return { ok: false, error: `这台设备错误次数太多，请 ${minutes} 分钟后再试` };
    }
  }
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
    if (byIp) ipLimiter.recordFailure(ipKey);
    await writeAudit({ userId: user?.id ?? null, action: "login_failed", detail: { username }, ip });
    return { ok: false, error: "账号或密码不对" };
  }

  if (limited) loginLimiter.reset(key);
  await writeAudit({ userId: user.id, action: "login", ip });
  return { ok: true, userId: user.id, sessionVersion: user.sessionVersion };
}
