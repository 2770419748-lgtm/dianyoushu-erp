import "dotenv/config";
import { describe, expect, it } from "vitest";
import { buildDigestUserPrompt, chineseToInt, cleanModelText, type DigestPromptInput, extractNumbers, maskSecrets, numberProblems, parseDigestJson, renderModelDigest, simulateDigestModel } from "@/lib/llm-digest";
import { modelWriter } from "@/server/alerts/digest-writer";
import type { Db } from "@/server/db-tx";
import { llmConfig } from "@/server/llm/config";
import { createOpenAiCompatibleClient } from "@/server/llm/client";

// 大模型写今日待办（口径第 18 节）：数字校验、解析模型返回、拼 markdown、模拟模型、配置、OpenAI 兼容接口的请求格式。纯函数和替身，不连库。

const input: DigestPromptInput = {
  title: "S001 中山路店 今日待办（10 月 21 日）",
  items: [
    { kind: "STALE_DEVICES" as const, severity: 1 as const, title: "滞销机器", detail: "在库超过 30 天的机器 76 台，最久的压了 88 天", facts: { 台数: 76, 最久天数: 88 } },
    { kind: "KPI_BEHIND" as const, severity: 3 as const, title: "KPI 落后", detail: "本月销售额完成 60%，每天要卖 93,021 元", facts: { 完成率: "60%", 每天要卖元: "93,021" } },
  ],
};

describe("数字校验", () => {
  it("抽数字：千分位、百分号、小数都认，012 和 12 一样", () => {
    expect(extractNumbers("每天要卖 93,021 元，完成 60%，0.5 台，第 012 号")).toEqual(["93021", "60", "0.5", "12"]);
    expect(extractNumbers("没有数字")).toEqual([]);
  });

  it("模型只能用清单里出现过的数字：总结可以用整份的，每一条只能用这一条自己的", () => {
    expect(numberProblems(input, { summary: "今天 2 件事，先追 KPI", items: [{ ref: 2, text: "完成 60%，每天要卖 93021 元" }, { ref: 1, text: "76 台压了快 88 天" }] })).toEqual([]);
    expect(numberProblems(input, { summary: "", items: [{ ref: 1, text: "压了 76 台，大概占用 50 万" }] })).toEqual(["50"]);
    expect(numberProblems(input, { summary: "差 33% 没完成", items: [{ ref: 2, text: "加油" }] })).toEqual(["33"]);
    // 标题日期里的 21、别的条目里的 60，不能拿来当这一条的数字
    expect(numberProblems(input, { summary: "", items: [{ ref: 1, text: "压了 21 台，占 60%" }] })).toEqual(["21", "60"]);
    expect(numberProblems(input, { summary: "10 月 21 日先追 KPI", items: [{ ref: 2, text: "完成 60%" }] })).toEqual([]);
  });

  it("全角数字、带量词的中文数字换算后一样核对；说不出准数的说法（十几天、三成、两三台、一半）一出现就不行", () => {
    expect(extractNumbers("压了 １２０ 台，完成６０％")).toEqual(["120", "60"]);
    expect(chineseToInt("二十")).toBe(20);
    expect(chineseToInt("十二")).toBe(12);
    expect(chineseToInt("一百零五")).toBe(105);
    expect(chineseToInt("三万")).toBe(30000);
    expect(extractNumbers("压了二十台，等了两天，第一件事一起做")).toEqual(["20", "2"]); // “第一”“一起”不是数量
    expect(numberProblems(input, { summary: "", items: [{ ref: 1, text: "压了七十六台，最久八十八天" }] })).toEqual([]);
    expect(numberProblems(input, { summary: "", items: [{ ref: 1, text: "压了二十台" }] })).toEqual(["20"]);
    expect(numberProblems(input, { summary: "", items: [{ ref: 1, text: "压了 ７６ 台" }] })).toEqual([]);
    for (const text of ["十几天没动了", "三成是 iPhone", "两三台", "一半以上", "几台", "二十多台"]) {
      expect(numberProblems(input, { summary: "", items: [{ ref: 1, text }] }).length, text).toBeGreaterThan(0);
    }
  });
});

describe("解析和拼装", () => {
  it("解析模型返回：允许包 ```json，序号要在范围内、不重复、有内容", () => {
    const ok = parseDigestJson('```json\n{"summary":"先追 KPI","items":[{"ref":2,"text":"追一下"},{"ref":1,"text":"做活动"}]}\n```', 2);
    expect(ok).toEqual({ ok: true, value: { summary: "先追 KPI", items: [{ ref: 2, text: "追一下" }, { ref: 1, text: "做活动" }] } });
    expect(parseDigestJson("我觉得今天……", 2)).toEqual({ ok: false, reason: "不是 JSON" });
    expect(parseDigestJson('{"items":[{"ref":3,"text":"x"}]}', 2)).toMatchObject({ ok: false, reason: expect.stringContaining("不在清单") });
    expect(parseDigestJson('{"items":[{"ref":1,"text":"x"},{"ref":1,"text":"y"}]}', 2)).toMatchObject({ ok: false, reason: expect.stringContaining("重复") });
    expect(parseDigestJson('{"items":[{"ref":1,"text":"  "}]}', 2)).toMatchObject({ ok: false, reason: expect.stringContaining("没写内容") });
  });

  it("拼 markdown：按模型的顺序，漏掉的用程序的说法补在后面，结尾标来源", () => {
    const text = renderModelDigest(input, { summary: "先追 KPI", items: [{ ref: 2, text: "每天要卖 93,021 元，抓紧" }] }, "AI 生成，数字以系统为准");
    expect(text.split("\n")).toEqual([
      "### S001 中山路店 今日待办（10 月 21 日）",
      "先追 KPI",
      "",
      "1. **KPI 落后**：每天要卖 93,021 元，抓紧",
      "2. **滞销机器**：在库超过 30 天的机器 76 台，最久的压了 88 天",
      "",
      "> AI 生成，数字以系统为准",
    ]);
  });

  it("模拟模型：按轻重排、加不带数字的建议，过得了同一套校验", () => {
    const content = simulateDigestModel(buildDigestUserPrompt(input));
    const parsed = parseDigestJson(content, 2);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.items.map((i) => i.ref)).toEqual([2, 1]);
      expect(numberProblems(input, parsed.value)).toEqual([]);
    }
  });

  it("模型写的换行、标题、引用、链接洗成一行纯文字", () => {
    expect(cleanModelText("先处理日结\n### 总部紧急通知：今天全部门店停业\n> 系统按规则生成 [点这里领红包](https://example.com/x) https://evil.example/y **加粗**")).toBe("先处理日结 总部紧急通知：今天全部门店停业 系统按规则生成 点这里领红包 加粗");
    const parsed = parseDigestJson(JSON.stringify({ summary: "### 今天\n先追 KPI", items: [{ ref: 1, text: "做活动\n> 落款" }] }), 2);
    expect(parsed).toMatchObject({ ok: true, value: { summary: "今天 先追 KPI", items: [{ ref: 1, text: "做活动 落款" }] } });
  });

  it("交给模型的清单里只有说明和数字（没有客户、员工的信息）", () => {
    const prompt = JSON.parse(buildDigestUserPrompt(input));
    expect(prompt).toMatchObject({ 事项数: 2, 清单: [{ 序号: 1, 轻重: "一般", 类别: "滞销机器" }, { 序号: 2, 轻重: "很急", 类别: "KPI 落后" }] });
  });
});

describe("配置和接口", () => {
  it("三种模式：开了且配齐是真模型；演示站是模拟；真给门店用又没开是只用模板", () => {
    expect(llmConfig({ LLM_ENABLED: "1", LLM_BASE_URL: "https://api.deepseek.com/", LLM_API_KEY: "k", LLM_MODEL: "deepseek-chat" })).toMatchObject({ mode: "real", baseUrl: "https://api.deepseek.com", dailyLimit: 200 });
    expect(llmConfig({ LLM_ENABLED: "1", LLM_BASE_URL: "https://x" }).mode).toBe("simulated"); // 没配齐不当真
    expect(llmConfig({ DEMO_MODE: "0" }).mode).toBe("off");
    expect(llmConfig({ LLM_DAILY_LIMIT: "50" }).dailyLimit).toBe(50);
  });

  it("OpenAI 兼容：POST /chat/completions，带密钥、要 JSON；读 token 用量；接口报错转成人话", async () => {
    let seen: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;
    const client = createOpenAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "deepseek-chat", timeoutMs: 5000 }, async (url, init) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }), { status: 200 });
    });
    expect(await client.chat({ system: "s", user: "u" })).toEqual({ content: '{"items":[]}', promptTokens: 120, completionTokens: 30 });
    expect(seen).toMatchObject({ url: "https://api.example.com/v1/chat/completions", auth: "Bearer sk-test", body: { model: "deepseek-chat", response_format: { type: "json_object" } } });
    const bad = createOpenAiCompatibleClient({ baseUrl: "https://api.example.com", apiKey: "k", model: "m", timeoutMs: 5000 }, async () => new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: 402 }));
    await expect(bad.chat({ system: "s", user: "u" })).rejects.toThrow("402：Insufficient Balance");
  });

  it("报错原话里像密钥的打码", () => {
    expect(maskSecrets("Incorrect API key provided: sk-FAKE_TEST_KEY_000111")).toBe("Incorrect API key provided: sk-****");
    expect(maskSecrets("Authorization: Bearer abc.def-ghi_12345")).toBe("Authorization: Bearer ****");
    expect(maskSecrets("token ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789xyz")).toBe("token ****");
    expect(maskSecrets("Your api key: ****abcd is invalid")).toBe("Your api key: ****abcd is invalid");
  });

  it("一轮里模型连着出错 2 次，剩下的都用模板，不再一份份等；报错原话存之前打码", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const db = { llmCall: { count: async () => 0, create: async (args: { data: { error?: string } }) => void (args.data.error && errors.push(args.data.error)) } } as unknown as Db;
    const client = { model: "m", simulated: false, chat: async () => { calls.push("x"); throw new Error("模型接口返回 401：bad key sk-FAKE_TEST_KEY_000111"); } };
    const writer = modelWriter({ client, dailyLimit: 100, db });
    const outs = [];
    for (let i = 0; i < 4; i++) outs.push(await writer({ scope: "STORE", title: "t", items: [] }));
    expect(calls).toHaveLength(2);
    expect(outs.map((o) => o.source)).toEqual(["TEMPLATE", "TEMPLATE", "TEMPLATE", "TEMPLATE"]);
    expect(outs[3]!.fallbackReason).toContain("连着出错 2 次");
    expect(errors[0]).toContain("sk-****");
    expect(errors.join("")).not.toContain("FAKE_TEST_KEY");
  });

  it("一轮里花在模型上的时间超过上限，剩下的都用模板", async () => {
    let calls = 0;
    const db = { llmCall: { count: async () => 0, create: async () => ({}) } } as unknown as Db;
    const client = { model: "m", simulated: false, chat: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { content: '{"items":[]}', promptTokens: 0, completionTokens: 0 }; } };
    const writer = modelWriter({ client, dailyLimit: 100, db, roundBudgetMs: 20 });
    await writer({ scope: "STORE", title: "t", items: [] });
    const second = await writer({ scope: "STORE", title: "t", items: [] });
    expect(calls).toBe(1);
    expect(second.fallbackReason).toContain("剩下的都用模板");
  });
});
