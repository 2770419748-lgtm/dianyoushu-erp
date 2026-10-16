// 登录限流：同一账号 + 来源 IP，15 分钟内错 5 次就锁 15 分钟。
// 状态放内存：演示版单进程部署够用；重启进程会清零，这是已知取舍。

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

type Attempt = { failures: number; windowStart: number; lockedUntil: number | null };

export type LimiterCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

export function createLoginLimiter(now: () => number = () => Date.now()) {
  const attempts = new Map<string, Attempt>();

  function current(key: string): Attempt {
    const t = now();
    let a = attempts.get(key);
    if (!a || (a.lockedUntil === null && t - a.windowStart > LOGIN_WINDOW_MS)) {
      a = { failures: 0, windowStart: t, lockedUntil: null };
      attempts.set(key, a);
    }
    if (a.lockedUntil !== null && t >= a.lockedUntil) {
      a = { failures: 0, windowStart: t, lockedUntil: null };
      attempts.set(key, a);
    }
    return a;
  }

  return {
    check(key: string): LimiterCheck {
      const a = current(key);
      if (a.lockedUntil !== null) {
        return { allowed: false, retryAfterMs: a.lockedUntil - now() };
      }
      return { allowed: true };
    },
    recordFailure(key: string): void {
      const a = current(key);
      a.failures += 1;
      if (a.failures >= LOGIN_MAX_FAILURES) {
        a.lockedUntil = now() + LOGIN_LOCK_MS;
      }
    },
    reset(key: string): void {
      attempts.delete(key);
    },
  };
}

export const loginLimiter = createLoginLimiter();
