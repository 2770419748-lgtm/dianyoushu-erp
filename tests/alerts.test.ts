import { describe, expect, it } from "vitest";
import { isWecomWebhookUrl, kpiBehind, renderTemplateDigest, scopeKeyOf, suggestTransfers, truncateUtf8 } from "@/lib/alerts";
import { pushToWecomGroup } from "@/server/alerts/push";

// 智能提醒（口径第 18 节）：KPI 落后、调拨建议、模板版今日待办、按字节截断、群机器人地址、推送重试。纯函数和替身，不连库。

describe("规则的判断", () => {
  it("KPI 落后：完成率比时间进度低 5 个百分点以上；没目标的不算", () => {
    expect(kpiBehind(0.6, 0.68)).toBe(true);
    expect(kpiBehind(0.64, 0.68)).toBe(false);
    expect(kpiBehind(0.63, 0.68)).toBe(true);
    expect(kpiBehind(null, 0.9)).toBe(false);
  });

  it("调拨建议：同区域、A 店有压货、B 店近 30 天卖 3 台以上且没货；每个型号一对，按压货排", () => {
    const rows = [
      { storeId: 1, storeName: "S001", regionId: 1, model: "Mate 70", inStock: 5, stale: 4, sold30: 0 },
      { storeId: 2, storeName: "S002", regionId: 1, model: "Mate 70", inStock: 0, stale: 0, sold30: 6 },
      { storeId: 3, storeName: "S003", regionId: 1, model: "Mate 70", inStock: 0, stale: 0, sold30: 9 },
      { storeId: 4, storeName: "S004", regionId: 2, model: "Mate 70", inStock: 0, stale: 0, sold30: 20 }, // 别的区域不算
      { storeId: 1, storeName: "S001", regionId: 1, model: "小米 15", inStock: 3, stale: 2, sold30: 0 },
      { storeId: 2, storeName: "S002", regionId: 1, model: "小米 15", inStock: 1, stale: 0, sold30: 8 }, // 有货就不建议
      { storeId: 1, storeName: "S001", regionId: 1, model: "iPhone 16", inStock: 2, stale: 2, sold30: 0 },
      { storeId: 3, storeName: "S003", regionId: 1, model: "iPhone 16", inStock: 0, stale: 0, sold30: 2 }, // 卖得不够快
    ];
    const s = suggestTransfers({ rows });
    expect(s).toEqual([{ regionId: 1, model: "Mate 70", from: { storeId: 1, storeName: "S001", stale: 4 }, to: { storeId: 3, storeName: "S003", sold30: 9 } }]);
  });

  it("范围的键：门店、区域、总部", () => {
    expect(scopeKeyOf({ scope: "STORE", storeId: 3, regionId: null })).toBe("store:3");
    expect(scopeKeyOf({ scope: "REGION", storeId: null, regionId: 2 })).toBe("region:2");
    expect(scopeKeyOf({ scope: "HQ", storeId: null, regionId: null })).toBe("hq");
  });
});

describe("今日待办和推送", () => {
  it("模板版按轻重排，结尾标“系统按规则生成”", () => {
    const text = renderTemplateDigest("S001 今日待办", [
      { severity: 1, title: "回收机没处理", detail: "3 台" },
      { severity: 3, title: "日结没做完", detail: "昨天没确认" },
    ]);
    expect(text.split("\n")).toEqual(["### S001 今日待办", "1. **日结没做完**：昨天没确认", "2. **回收机没处理**：3 台", "", "> 系统按规则生成"]);
  });

  it("超过 4096 字节按字节截断，不截断半个汉字", () => {
    const long = "滞".repeat(2000); // 6000 字节
    const out = truncateUtf8(long);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(4096);
    expect(out.endsWith("智能提醒页）")).toBe(true);
    expect(truncateUtf8("短的")).toBe("短的");
  });

  it("群机器人地址只认企业微信官方的", () => {
    expect(isWecomWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa")).toBe(true);
    expect(isWecomWebhookUrl("http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx")).toBe(false);
    expect(isWecomWebhookUrl("https://192.168.1.1/cgi-bin/webhook/send?key=693a91f6-7xxx")).toBe(false);
    expect(isWecomWebhookUrl("https://qyapi.weixin.qq.com.evil.com/cgi-bin/webhook/send?key=693a91f6-7xxx")).toBe(false);
  });

  it("推送：没填 NONE、没打开 SIMULATED、失败重试一次再报 FAILED、成功 SENT", async () => {
    const url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key-123456";
    expect(await pushToWecomGroup(null, "x")).toEqual({ status: "NONE" });
    expect(await pushToWecomGroup(url, "x", { enabled: false })).toEqual({ status: "SIMULATED" });
    expect(await pushToWecomGroup("https://evil.example.com/x", "x", { enabled: true })).toMatchObject({ status: "FAILED" });
    let calls = 0;
    const flaky = async () => {
      calls++;
      return new Response(JSON.stringify(calls === 1 ? { errcode: 45009, errmsg: "busy" } : { errcode: 0, errmsg: "ok" }), { status: 200 });
    };
    expect(await pushToWecomGroup(url, "x", { enabled: true, transport: flaky })).toEqual({ status: "SENT" });
    expect(calls).toBe(2);
    const down = async () => new Response("bad", { status: 502 });
    expect(await pushToWecomGroup(url, "x", { enabled: true, transport: down })).toMatchObject({ status: "FAILED", error: expect.stringContaining("502") });
  });
});
