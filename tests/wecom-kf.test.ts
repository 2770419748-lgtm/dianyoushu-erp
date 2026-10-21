import { describe, expect, it } from "vitest";
import { canSendKf, detectKfIntent, extractProductQuery, isAmbiguousModelQuery, matchModels, normalizeName, parseKfMessage } from "@/lib/wecom-kf";

// 微信客服（口径第 12 节第三步）：认意图、抽机型、找型号、48 小时 5 条、解析企业微信的消息。纯函数，不连库。

describe("认意图", () => {
  it("要人工的词优先，其次我的保障、理赔、保修、营业时间地址、价格库存", () => {
    expect(detectKfIntent("我要投诉")).toBe("HUMAN");
    expect(detectKfIntent("转人工")).toBe("HUMAN");
    expect(detectKfIntent("我想退货，多少钱能退")).toBe("HUMAN");
    expect(detectKfIntent("屏幕修一下多少钱")).toBe("HUMAN"); // 维修报价规则答不了
    expect(detectKfIntent("我的碎屏险到什么时候")).toBe("MY_ENTITLEMENT");
    expect(detectKfIntent("我上个月买的手机保修还有多久")).toBe("MY_ENTITLEMENT");
    expect(detectKfIntent("手机屏幕摔碎了怎么赔")).toBe("CLAIM");
    expect(detectKfIntent("保修多久")).toBe("WARRANTY");
    expect(detectKfIntent("你们几点关门？")).toBe("HOURS");
    expect(detectKfIntent("门店地址在哪")).toBe("HOURS");
    expect(detectKfIntent("iPhone 16 Pro 多少钱？有货吗")).toBe("PRICE");
    expect(detectKfIntent("在吗")).toBe("UNKNOWN");
    // 复查后补
    expect(detectKfIntent("退钱")).toBe("HUMAN");
    expect(detectKfIntent("我想退")).toBe("HUMAN");
    expect(detectKfIntent("我的手机坏了")).toBe("REPAIR");
    expect(detectKfIntent("保修多少钱")).toBe("WARRANTY");
    expect(detectKfIntent("   ")).toBe("UNKNOWN");
  });
});

describe("找型号", () => {
  const models = [
    { id: 1, name: "iPhone 16", brand: "苹果" },
    { id: 2, name: "iPhone 16 Pro", brand: "苹果" },
    { id: 3, name: "iPhone 16 Pro Max", brand: "苹果" },
    { id: 4, name: "Mate 70", brand: "华为" },
  ];

  it("抽出机型：去掉问价的话和空格，大小写不分", () => {
    expect(extractProductQuery("iPhone 16 Pro 多少钱？有货吗")).toBe("iphone16pro");
    expect(extractProductQuery("多少钱")).toBeNull();
    expect(normalizeName("Mate 70 Pro+")).toBe("mate70pro");
  });

  it("说全了型号的只给这个型号（“iPhone 16 Pro”不再带上“iPhone 16”）；只说了一部分的给最接近的几个", () => {
    expect(matchModels(models, "iphone16pro").map((m) => m.id)).toEqual([2]);
    expect(matchModels(models, "iphone16").map((m) => m.id)).toEqual([1]);
    expect(matchModels(models, "华为mate70").map((m) => m.id)).toEqual([4]);
    expect(matchModels(models, "iphone").map((m) => m.id)).toEqual([1, 2, 3]);
    expect(matchModels(models, "pixel9")).toEqual([]);
    expect(matchModels(models, "苹果16").map((m) => m.id)).toEqual([1]); // “苹果”当成 iPhone
  });

  it("只说了“pro”“13”这种好几个牌子都有的：先问牌子", () => {
    const many = [
      { id: 1, name: "15 Pro", brand: "小米" },
      { id: 2, name: "Mate 70 Pro", brand: "华为" },
      { id: 3, name: "13", brand: "一加" },
      { id: 4, name: "nova 13", brand: "华为" },
    ];
    expect(isAmbiguousModelQuery(many, "pro")).toBe(true);
    expect(isAmbiguousModelQuery(many, "13")).toBe(true);
    expect(isAmbiguousModelQuery(many, "mate70pro")).toBe(false);
    expect(isAmbiguousModelQuery(many, "nova13")).toBe(false);
  });
});

describe("能不能发", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  it("客户发消息后 48 小时内、回了不到 5 条才能发", () => {
    expect(canSendKf(new Date("2026-10-19T12:00:00Z"), 0, now).ok).toBe(true);
    expect(canSendKf(new Date("2026-10-18T11:59:00Z"), 0, now)).toMatchObject({ ok: false, reason: expect.stringContaining("48 小时") });
    expect(canSendKf(new Date("2026-10-20T11:00:00Z"), 5, now)).toMatchObject({ ok: false, reason: expect.stringContaining("5 条") });
    expect(canSendKf(null, 0, now).ok).toBe(false);
  });
});

describe("解析企业微信的消息", () => {
  it("文字消息和事件消息（事件的客户 id 在 event 里）", () => {
    const text = parseKfMessage({ msgid: "m1", open_kfid: "wk1", external_userid: "wm1", send_time: 1700000000, origin: 3, msgtype: "text", text: { content: "你好" } });
    expect(text).toMatchObject({ msgid: "m1", openKfid: "wk1", externalUserid: "wm1", origin: 3, msgType: "text", text: "你好", event: null });
    expect(text.sendTime.getTime()).toBe(1700000000 * 1000);
    const event = parseKfMessage({ msgid: "m2", send_time: 1700000001, origin: 4, msgtype: "event", event: { event_type: "session_status_change", open_kfid: "wk1", external_userid: "wm2", change_type: 3 } });
    expect(event).toMatchObject({ openKfid: "wk1", externalUserid: "wm2", event: { type: "session_status_change", changeType: 3 } });
  });
});
