import "server-only";
import { prisma } from "@/lib/prisma";
import { type AlertDraft, type AlertScopeKey, renderTemplateDigest } from "@/lib/alerts";
import { formatDate } from "@/lib/format";
import { allowedNumbers, buildDigestUserPrompt, LLM_SYSTEM_PROMPT, parseDigestJson, renderModelDigest, unknownNumbers } from "@/lib/llm-digest";
import type { Db } from "@/server/db-tx";
import { createOpenAiCompatibleClient, createSimulatedLlmClient, type LlmClient, llmConfig } from "@/server/llm/client";

// 今日待办谁来写（口径第 18 节）：模型写 → 程序校验（格式、序号、每个数字都在清单里）→ 不行就改发模板版并记原因。
// 模型挂了、超时、超过每天的调用上限，都改发模板版，门店照常收到提醒。

export interface DigestInput {
  scope: AlertScopeKey;
  title: string;
  items: AlertDraft[];
}

export interface DigestOutput {
  content: string;
  source: "MODEL" | "SIMULATED" | "TEMPLATE";
  fallbackReason: string | null;
}

export type DigestWriter = (input: DigestInput) => Promise<DigestOutput>;

export const templateWriter: DigestWriter = async (input) => ({ content: renderTemplateDigest(input.title, input.items), source: "TEMPLATE", fallbackReason: null });

/** 北京时间今天 0 点（每天的调用上限从这里数） */
function startOfToday(now: Date): Date {
  return new Date(new Date(formatDate(now)).getTime() - 8 * 3600 * 1000);
}

/**
 * 用模型写的 writer。dailyLimit：真模型每天最多调几次（模拟模型不限）。
 * 每次调用都记一条 llm_calls（模型名、成没成、token、耗时），不存提示和回答的全文。
 */
export function modelWriter(options: { client: LlmClient; dailyLimit: number; db?: Db; now?: () => Date }): DigestWriter {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const { client } = options;
  return async (input) => {
    const fallback = (reason: string): DigestOutput => ({ content: renderTemplateDigest(input.title, input.items), source: "TEMPLATE", fallbackReason: reason });
    if (!client.simulated) {
      const used = await db.llmCall.count({ where: { createdAt: { gte: startOfToday(now()) }, model: { not: "simulated" } } });
      if (used >= options.dailyLimit) return fallback(`今天调用模型的次数到上限了（${options.dailyLimit} 次）`);
    }
    const started = Date.now();
    let reply;
    try {
      reply = await client.chat({ system: LLM_SYSTEM_PROMPT, user: buildDigestUserPrompt(input) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.llmCall.create({ data: { purpose: "alerts", model: client.model, ok: false, latencyMs: Date.now() - started, error: message.slice(0, 300) } });
      return fallback(`模型出错：${message}`);
    }
    await db.llmCall.create({ data: { purpose: "alerts", model: client.model, ok: true, promptTokens: reply.promptTokens, completionTokens: reply.completionTokens, latencyMs: Date.now() - started } });
    const parsed = parseDigestJson(reply.content, input.items.length);
    if (!parsed.ok) return fallback(`模型返回的格式不对：${parsed.reason}`);
    const bad = unknownNumbers(parsed.value, allowedNumbers(input));
    if (bad.length > 0) return fallback(`模型写了清单外的数字：${bad.slice(0, 5).join("、")}`);
    const footer = client.simulated ? "模拟模型生成（演示），数字以系统为准" : "AI 生成，数字以系统为准";
    return { content: renderModelDigest(input, parsed.value, footer), source: client.simulated ? "SIMULATED" : "MODEL", fallbackReason: null };
  };
}

/** 按 .env 选：真模型、模拟模型（演示站）、只用模板（真给门店用又没开模型） */
export function getDigestWriter(env: Record<string, string | undefined> = process.env): DigestWriter {
  const cfg = llmConfig(env);
  if (cfg.mode === "real") return modelWriter({ client: createOpenAiCompatibleClient(cfg), dailyLimit: cfg.dailyLimit });
  if (cfg.mode === "simulated") return modelWriter({ client: createSimulatedLlmClient(), dailyLimit: cfg.dailyLimit });
  return templateWriter;
}
