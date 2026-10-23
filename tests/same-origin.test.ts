import { describe, expect, it } from "vitest";
import { isSameOrigin } from "@/lib/same-origin";

// 清失效登录的接口只认本站发的 POST（口径第 20 节）：看 Origin 的主机名和这次请求的主机名对不对得上。

const h = (init: Record<string, string>) => new Headers(init);

describe("请求是不是本站发的", () => {
  it("Origin 和 Host 一样才算", () => {
    expect(isSameOrigin(h({ origin: "https://erp.example.com", host: "erp.example.com" }))).toBe(true);
    expect(isSameOrigin(h({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
    expect(isSameOrigin(h({ origin: "https://evil.example.net", host: "erp.example.com" }))).toBe(false);
  });

  it("在 Caddy 后面看 X-Forwarded-Host", () => {
    expect(isSameOrigin(h({ origin: "https://erp.example.com", host: "app:3000", "x-forwarded-host": "erp.example.com" }))).toBe(true);
    expect(isSameOrigin(h({ origin: "https://evil.example.net", host: "app:3000", "x-forwarded-host": "erp.example.com" }))).toBe(false);
  });

  it("没有 Origin、Origin 是 null 或乱写的都不算", () => {
    expect(isSameOrigin(h({ host: "erp.example.com" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "null", host: "erp.example.com" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "not a url", host: "erp.example.com" }))).toBe(false);
  });
});
