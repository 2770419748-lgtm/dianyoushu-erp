import { describe, expect, it } from "vitest";
import { checkProductionEnv, checkProductionWarnings } from "@/server/config-check";

// 生产环境启动前的配置检查：弱密钥、占位值、没配数据库都要拦下。
const goodSecret = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMTI="; // 44 个字符
const goodDb = "postgresql://erp:Xk29fLq8Tz@db:5432/dianyoushu_erp";

describe("checkProductionEnv", () => {
  it("配置合格时没有问题", () => {
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DATABASE_URL: goodDb, DEMO_MODE: "1" })).toEqual([]);
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DATABASE_URL: goodDb, DEMO_MODE: "0" })).toEqual([]);
  });

  it("会话密钥没设、太短、还是占位值都拦", () => {
    expect(checkProductionEnv({ DATABASE_URL: goodDb, DEMO_MODE: "1" })[0]).toContain("没有设置 SESSION_SECRET");
    expect(checkProductionEnv({ SESSION_SECRET: "short-secret-16ch", DATABASE_URL: goodDb, DEMO_MODE: "1" })[0]).toContain("太短");
    expect(checkProductionEnv({ SESSION_SECRET: "换成你自己的随机字符串", DATABASE_URL: goodDb, DEMO_MODE: "1" })[0]).toContain("占位值");
  });

  it("数据库连接没设、密码还是示例值都拦", () => {
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DEMO_MODE: "1" })).toEqual(["没有设置 DATABASE_URL"]);
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DATABASE_URL: "postgresql://postgres:你的密码@localhost:5432/x", DEMO_MODE: "1" })[0]).toContain("示例值");
  });

  it("DEMO_MODE 必须写明：不写拒绝启动，写 1 只提醒（演示站本身就是生产环境）", () => {
    const base = { SESSION_SECRET: goodSecret, DATABASE_URL: goodDb };
    expect(checkProductionEnv(base)).toEqual(["没有写明 DEMO_MODE：演示站写 1，真给门店用写 0"]);
    expect(checkProductionEnv({ ...base, DEMO_MODE: "yes" })[0]).toContain("只能是 0 或 1");
    expect(checkProductionWarnings({ ...base, DEMO_MODE: "1" })[0]).toContain("演示站");
    expect(checkProductionWarnings({ ...base, DEMO_MODE: "0" })).toEqual([]);
  });

  it("开了企业微信真对接，自建应用 Secret 和回调配置缺一不可", () => {
    const base = { SESSION_SECRET: goodSecret, DATABASE_URL: goodDb, DEMO_MODE: "0" };
    expect(checkProductionEnv({ ...base, WECOM_ENABLED: "0" })).toEqual([]);
    expect(checkProductionEnv({ ...base, WECOM_ENABLED: "1" })[0]).toContain("WECOM_CORP_ID、WECOM_APP_SECRET、WECOM_AGENT_ID、WECOM_CALLBACK_TOKEN、WECOM_CALLBACK_AES_KEY");
    const full = { ...base, WECOM_ENABLED: "1", WECOM_CORP_ID: "ww123", WECOM_APP_SECRET: "s", WECOM_AGENT_ID: "1000002", WECOM_CALLBACK_TOKEN: "t", WECOM_CALLBACK_AES_KEY: "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C" };
    expect(checkProductionEnv(full)).toEqual([]);
    expect(checkProductionEnv({ ...full, WECOM_CALLBACK_AES_KEY: "too-short" })[0]).toContain("43 位");
    expect(checkProductionEnv({ ...full, WECOM_AGENT_ID: "abc" })[0]).toContain("数字");
    expect(checkProductionEnv({ ...base, WECOM_ENABLED: "true" })[0]).toContain("只能是 0 或 1");
  });
});
