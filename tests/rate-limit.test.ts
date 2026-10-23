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

describe("先占名额再核对（consume，2026-10-23 复查后补）", () => {
  it("同一时刻来一堆请求：只有限额内的能去核对，满了后面的直接拒", () => {
    const limiter = createLoginLimiter(makeClock().now);
    const results = Array.from({ length: 300 }, () => limiter.consume("k").allowed);
    expect(results.filter(Boolean)).toHaveLength(LOGIN_MAX_FAILURES);
    expect(limiter.check("k").allowed).toBe(false);
  });

  it("核对成功 reset 清零；refund 只退回这一次，不清掉之前的错", () => {
    const limiter = createLoginLimiter(makeClock().now);
    limiter.consume("k");
    limiter.consume("k");
    limiter.refund("k"); // 第二次成功了：只退回第二次
    for (let i = 0; i < LOGIN_MAX_FAILURES - 2; i++) limiter.consume("k");
    expect(limiter.check("k").allowed).toBe(true); // 记了 MAX-1 次
    limiter.consume("k");
    expect(limiter.check("k").allowed).toBe(false);
    limiter.refund("k"); // 最后一次其实不算错：解锁
    expect(limiter.check("k").allowed).toBe(true);
    limiter.reset("k");
    expect(Array.from({ length: LOGIN_MAX_FAILURES }, () => limiter.consume("k").allowed).every(Boolean)).toBe(true);
  });
});
