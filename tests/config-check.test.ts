import { describe, expect, it } from "vitest";
import { checkProductionEnv } from "@/server/config-check";

// 生产环境启动前的配置检查：弱密钥、占位值、没配数据库都要拦下。
const goodSecret = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMTI="; // 44 个字符
const goodDb = "postgresql://erp:Xk29fLq8Tz@db:5432/dianyoushu_erp";

describe("checkProductionEnv", () => {
  it("配置合格时没有问题", () => {
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DATABASE_URL: goodDb })).toEqual([]);
  });

  it("会话密钥没设、太短、还是占位值都拦", () => {
    expect(checkProductionEnv({ DATABASE_URL: goodDb })[0]).toContain("没有设置 SESSION_SECRET");
    expect(checkProductionEnv({ SESSION_SECRET: "short-secret-16ch", DATABASE_URL: goodDb })[0]).toContain("太短");
    expect(checkProductionEnv({ SESSION_SECRET: "换成你自己的随机字符串", DATABASE_URL: goodDb })[0]).toContain("占位值");
  });

  it("数据库连接没设、密码还是示例值都拦", () => {
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret })).toEqual(["没有设置 DATABASE_URL"]);
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DATABASE_URL: "postgresql://postgres:你的密码@localhost:5432/x" })[0]).toContain("示例值");
  });
});
