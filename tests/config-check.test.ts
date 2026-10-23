import { describe, expect, it } from "vitest";
import { checkProductionEnv, checkProductionWarnings } from "@/server/config-check";

// 生产环境启动前的配置检查：弱密钥、占位值、没配数据库都要拦下。
const goodSecret = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMTI="; // 44 个字符
const goodDb = "postgresql://erp:Xk29fLq8Tz@db:5432/dianyoushu_erp";
// 个人信息加密的两把钥匙（口径第 20 节），32 字节的 base64
const keys = { DATA_ENCRYPTION_KEY: "q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq4M=", DATA_INDEX_KEY: "ESIzRFVmd4iZqrvM3e7/ABEiM0RVZneImaq7zN3u/wA=" };

describe("checkProductionEnv", () => {
  it("个人信息加密钥匙：没配、格式不对、用了开发或 CI 的公开钥匙、两把一样都拦（口径第 20 节）", () => {
    const base = { SESSION_SECRET: goodSecret, DATABASE_URL: goodDb, DEMO_MODE: "0" };
    expect(checkProductionEnv(base).join("\n")).toMatch(/没有设置 DATA_ENCRYPTION_KEY[\s\S]*没有设置 DATA_INDEX_KEY/);
    expect(checkProductionEnv({ ...base, ...keys, DATA_INDEX_KEY: "too-short" })).toEqual(["DATA_INDEX_KEY 格式不对：要 32 字节的 base64"]);
    expect(checkProductionEnv({ ...base, ...keys, DATA_ENCRYPTION_KEY: "+mrWWYKQtIiQW76PKlbB3wfQztJldVkvibecdn4h1UU=" })[0]).toContain("公开钥匙");
    expect(checkProductionEnv({ ...base, ...keys, DATA_INDEX_KEY: "Y2ktb25seS1kYXRhLWluZGV4LWtleS0zMmJ5dGVzISE=" })[0]).toContain("公开钥匙");
    expect(checkProductionEnv({ ...base, ...keys, DATA_INDEX_KEY: keys.DATA_ENCRYPTION_KEY })).toEqual(["DATA_ENCRYPTION_KEY 和 DATA_INDEX_KEY 不能用同一个"]);
  });

  it("配置合格时没有问题", () => {
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DATABASE_URL: goodDb, DEMO_MODE: "1", ...keys })).toEqual([]);
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DATABASE_URL: goodDb, DEMO_MODE: "0", ...keys })).toEqual([]);
  });

  it("会话密钥没设、太短、还是占位值都拦", () => {
    expect(checkProductionEnv({ DATABASE_URL: goodDb, DEMO_MODE: "1" })[0]).toContain("没有设置 SESSION_SECRET");
    expect(checkProductionEnv({ SESSION_SECRET: "short-secret-16ch", DATABASE_URL: goodDb, DEMO_MODE: "1" })[0]).toContain("太短");
    expect(checkProductionEnv({ SESSION_SECRET: "换成你自己的随机字符串", DATABASE_URL: goodDb, DEMO_MODE: "1" })[0]).toContain("占位值");
  });

  it("数据库连接没设、密码还是示例值都拦", () => {
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DEMO_MODE: "1", ...keys })).toEqual(["没有设置 DATABASE_URL"]);
    expect(checkProductionEnv({ SESSION_SECRET: goodSecret, DATABASE_URL: "postgresql://postgres:你的密码@localhost:5432/x", DEMO_MODE: "1", ...keys })[0]).toContain("示例值");
  });

  it("DEMO_MODE 必须写明：不写拒绝启动，写 1 只提醒（演示站本身就是生产环境）", () => {
    const base = { SESSION_SECRET: goodSecret, DATABASE_URL: goodDb, ...keys };
    expect(checkProductionEnv(base)).toEqual(["没有写明 DEMO_MODE：演示站写 1，真给门店用写 0"]);
    expect(checkProductionEnv({ ...base, DEMO_MODE: "yes" })[0]).toContain("只能是 0 或 1");
    expect(checkProductionWarnings({ ...base, DEMO_MODE: "1" })[0]).toContain("演示站");
    expect(checkProductionWarnings({ ...base, DEMO_MODE: "0" })).toEqual([]);
  });

  it("开了企业微信真对接，自建应用 Secret 和回调配置缺一不可", () => {
    const base = { SESSION_SECRET: goodSecret, DATABASE_URL: goodDb, DEMO_MODE: "0", ...keys };
    expect(checkProductionEnv({ ...base, WECOM_ENABLED: "0" })).toEqual([]);
    expect(checkProductionEnv({ ...base, WECOM_ENABLED: "1" })[0]).toContain("WECOM_CORP_ID、WECOM_APP_SECRET、WECOM_AGENT_ID、WECOM_CALLBACK_TOKEN、WECOM_CALLBACK_AES_KEY");
    const full = { ...base, WECOM_ENABLED: "1", WECOM_CORP_ID: "ww123", WECOM_APP_SECRET: "s", WECOM_AGENT_ID: "1000002", WECOM_CALLBACK_TOKEN: "t", WECOM_CALLBACK_AES_KEY: "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C" };
    expect(checkProductionEnv(full)).toEqual([]);
    expect(checkProductionEnv({ ...full, WECOM_CALLBACK_AES_KEY: "too-short" })[0]).toContain("43 位");
    expect(checkProductionEnv({ ...full, WECOM_AGENT_ID: "abc" })[0]).toContain("数字");
    // 大模型（口径第 18 节）：打开了要地址、密钥、模型名，地址要 https
    expect(checkProductionEnv({ ...base, LLM_ENABLED: "1" })[0]).toContain("LLM_BASE_URL、LLM_API_KEY、LLM_MODEL");
    expect(checkProductionEnv({ ...base, LLM_ENABLED: "1", LLM_BASE_URL: "http://api.example.com", LLM_API_KEY: "k", LLM_MODEL: "m" })[0]).toContain("https");
    expect(checkProductionEnv({ ...base, LLM_ENABLED: "1", LLM_BASE_URL: "https://api.deepseek.com", LLM_API_KEY: "k", LLM_MODEL: "deepseek-chat" })).toEqual([]);
    expect(checkProductionEnv({ ...base, ALERT_PUSH_ENABLED: "yes" })[0]).toContain("ALERT_PUSH_ENABLED");
    expect(checkProductionEnv({ ...base, WECOM_ENABLED: "true" })[0]).toContain("只能是 0 或 1");
  });
});
