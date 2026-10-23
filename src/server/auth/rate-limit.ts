// 登录限流的计数器：同一个 key 15 分钟内错 N 次就锁 15 分钟（key 怎么拼见 login-service.ts）。
// 状态放内存：单进程部署够用；重启进程会清零，多实例部署时要换成数据库或 Redis（上线前检查清单里写了）。

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

type Attempt = { failures: number; windowStart: number; lockedUntil: number | null };

export type LimiterCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

export function createLoginLimiter(now: () => number = () => Date.now(), maxFailures = LOGIN_MAX_FAILURES) {
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
      if (a.failures >= maxFailures) {
        a.lockedUntil = now() + LOGIN_LOCK_MS;
      }
    },
    /**
     * 先占一次名额再去核对（2026-10-23 复查后补）：放行的同时就记一次失败，核对成功了调用方再 reset 或 refund。
     * 先 check、await 查库、错了才 recordFailure 的写法，同时发几百个请求时都在 await 之前过了 check，限流形同虚设；
     * 这里没有 await，同时来的请求按顺序一个个占名额，满了后面的直接拒。
     */
    consume(key: string): LimiterCheck {
      const a = current(key);
      if (a.lockedUntil !== null) {
        return { allowed: false, retryAfterMs: a.lockedUntil - now() };
      }
      a.failures += 1;
      if (a.failures >= maxFailures) {
        a.lockedUntil = now() + LOGIN_LOCK_MS;
      }
      return { allowed: true };
    },
    /** 退回 consume 占的一次（核对成功、或者这次不该算失败），不清掉之前别的失败记录 */
    refund(key: string): void {
      const a = attempts.get(key);
      if (!a || a.failures === 0) return;
      a.failures -= 1;
      if (a.failures < maxFailures) a.lockedUntil = null;
    },
    reset(key: string): void {
      attempts.delete(key);
    },
  };
}

export const loginLimiter = createLoginLimiter();
