import "server-only";
import { simulateDigestModel } from "@/lib/llm-digest";
import { llmConfig } from "./config";

export { llmConfig, LLM_REQUIRED_ENV, type LlmMode } from "./config";

// 大模型接口（口径第 18 节）。按 OpenAI 兼容接口写（DeepSeek、通义千问都支持），换哪家只改 .env 的地址、密钥、模型名。
// 三种模式：
// - real：LLM_ENABLED=1 且地址、密钥、模型名都填了；
// - simulated：没开真模型、但在演示模式（DEMO_MODE 不是 0）——用模拟模型，不连网；
// - off：真给门店用又没开模型，今日待办只发模板版。
// 密钥只放服务器的 .env，不进仓库。

type Env = Record<string, string | undefined>;

export class LlmError extends Error {}

export interface LlmReply {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

export interface LlmClient {
  readonly model: string;
  readonly simulated: boolean;
  chat(input: { system: string; user: string }): Promise<LlmReply>;
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** OpenAI 兼容的 /chat/completions：要求只回 JSON，温度低一点，超时就算失败（今日待办改发模板版） */
export function createOpenAiCompatibleClient(cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }, transport: Transport = (u, init) => fetch(u, init)): LlmClient {
  return {
    model: cfg.model,
    simulated: false,
    async chat(input) {
      let res: Response;
      try {
        res = await transport(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.user },
            ],
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (error) {
        throw new LlmError(error instanceof Error && error.name === "TimeoutError" ? "模型超时" : "连不上模型接口");
      }
      const data = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
      if (!res.ok) throw new LlmError(`模型接口返回 ${res.status}${data.error?.message ? `：${data.error.message.slice(0, 120)}` : ""}`);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content) throw new LlmError("模型没有返回内容");
      return { content, promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 };
    },
  };
}

/** 模拟模型：不连网，按清单排序、加建议（见 src/lib/llm-digest.ts） */
export function createSimulatedLlmClient(): LlmClient {
  return {
    model: "simulated",
    simulated: true,
    async chat(input) {
      return { content: simulateDigestModel(input.user), promptTokens: 0, completionTokens: 0 };
    },
  };
}

/** 按模式取：off 返回 null（只发模板版） */
export function getLlmClient(env: Env = process.env): LlmClient | null {
  const cfg = llmConfig(env);
  if (cfg.mode === "real") return createOpenAiCompatibleClient(cfg);
  if (cfg.mode === "simulated") return createSimulatedLlmClient();
  return null;
}
