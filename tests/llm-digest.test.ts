import { describe, expect, it } from "vitest";
import { allowedNumbers, buildDigestUserPrompt, type DigestPromptInput, extractNumbers, parseDigestJson, renderModelDigest, simulateDigestModel, unknownNumbers } from "@/lib/llm-digest";
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

  it("模型只能用清单里出现过的数字（标题、事项数、说明、数字都算）", () => {
    const allowed = allowedNumbers(input);
    expect(unknownNumbers({ summary: "今天 2 件事，先追 KPI", items: [{ ref: 2, text: "完成 60%，每天要卖 93021 元" }, { ref: 1, text: "76 台压了快 88 天" }] }, allowed)).toEqual([]);
    expect(unknownNumbers({ summary: "", items: [{ ref: 1, text: "压了 76 台，大概占用 50 万" }] }, allowed)).toEqual(["50"]);
    expect(unknownNumbers({ summary: "差 33% 没完成", items: [{ ref: 2, text: "加油" }] }, allowed)).toEqual(["33"]);
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
      expect(unknownNumbers(parsed.value, allowedNumbers(input))).toEqual([]);
    }
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
});
