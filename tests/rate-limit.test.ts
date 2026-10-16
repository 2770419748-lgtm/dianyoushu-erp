import { describe, expect, it } from "vitest";
import { createLoginLimiter, LOGIN_LOCK_MS, LOGIN_MAX_FAILURES } from "@/server/auth/rate-limit";

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("登录限流", () => {
  it("错 5 次后第 6 次被拦", () => {
    const clock = makeClock();
    const limiter = createLoginLimiter(clock.now);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect(limiter.check("staff@1.1.1.1").allowed).toBe(true);
      limiter.recordFailure("staff@1.1.1.1");
    }
    const result = limiter.check("staff@1.1.1.1");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.retryAfterMs).toBe(LOGIN_LOCK_MS);
  });

  it("锁定时间过了自动解锁", () => {
    const clock = makeClock();
    const limiter = createLoginLimiter(clock.now);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) limiter.recordFailure("k");
    expect(limiter.check("k").allowed).toBe(false);
    clock.advance(LOGIN_LOCK_MS);
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("登录成功后清零", () => {
    const limiter = createLoginLimiter(makeClock().now);
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) limiter.recordFailure("k");
    limiter.reset("k");
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) limiter.recordFailure("k");
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("不同账号互不影响", () => {
    const limiter = createLoginLimiter(makeClock().now);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) limiter.recordFailure("a@ip");
    expect(limiter.check("a@ip").allowed).toBe(false);
    expect(limiter.check("b@ip").allowed).toBe(true);
  });
});
