import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { type DigestInput, modelWriter } from "@/server/alerts/digest-writer";
import { createSimulatedLlmClient, type LlmClient } from "@/server/llm/client";

// 今日待办的写法（口径第 18 节，连本机库，事务回滚不留数据）：模型写得对就用、数字对不上 / 格式不对 / 出错 / 超额都改发模板版，
// 每次调用记一条 llm_calls；模拟模型标 SIMULATED。

class Rollback extends Error {}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

afterAll(async () => {
  await prisma.$disconnect();
});

const input: DigestInput = {
  scope: "STORE",
  title: "测试店 今日待办（10 月 21 日）",
  items: [
    { kind: "STALE_DEVICES" as const, scope: "STORE" as const, storeId: 1, regionId: null, severity: 1 as const, title: "滞销机器", detail: "在库超过 30 天的机器 12 台", link: "/stock", facts: { 台数: 12 } },
    { kind: "DAILY_CLOSE" as const, scope: "STORE" as const, storeId: 1, regionId: null, severity: 3 as const, title: "日结没做完", detail: "2026-10-20 的日结还没确认", link: "/daily-close", facts: { 日期: "2026-10-20" } },
  ],
};

function fakeClient(reply: string | Error): LlmClient {
  return {
    model: "fake-model",
    simulated: false,
    async chat() {
      if (reply instanceof Error) throw reply;
      return { content: reply, promptTokens: 300, completionTokens: 80 };
    },
  };
}

describe("今日待办的写法（连本机库，事务回滚）", () => {
  it("模型写得对就用，记一条调用；写了清单外的数字、格式不对、出错，都改发模板版并写原因", async () => {
    await inRolledBackTx(async (tx) => {
      const good = await modelWriter({ db: tx, dailyLimit: 10, client: fakeClient('{"summary":"先把日结做了","items":[{"ref":2,"text":"昨天的日结还没确认，先核对实收"},{"ref":1,"text":"12 台压太久了，做个活动"}]}') })(input);
      expect(good).toMatchObject({ source: "MODEL", fallbackReason: null });
      expect(good.content).toContain("1. **日结没做完**：昨天的日结还没确认");
      expect(good.content).toContain("> AI 生成，数字以系统为准");

      const madeUp = await modelWriter({ db: tx, dailyLimit: 10, client: fakeClient('{"items":[{"ref":1,"text":"压了 12 台，大概占了 8 万块"}]}') })(input);
      expect(madeUp).toMatchObject({ source: "TEMPLATE", fallbackReason: "模型写的数字对不上清单：8" });
      expect(madeUp.content).toContain("> 系统按规则生成");

      expect((await modelWriter({ db: tx, dailyLimit: 10, client: fakeClient("今天要做的事有……") })(input)).fallbackReason).toBe("模型返回的格式不对：不是 JSON");
      expect((await modelWriter({ db: tx, dailyLimit: 10, client: fakeClient(new Error("模型超时")) })(input)).fallbackReason).toBe("模型出错：模型超时");

      const calls = await tx.llmCall.findMany({ where: { model: "fake-model" }, orderBy: { id: "asc" } });
      expect(calls.map((c) => c.ok)).toEqual([true, true, true, false]);
      expect(calls[0]).toMatchObject({ purpose: "alerts", promptTokens: 300, completionTokens: 80 });
      expect(calls[3]!.error).toBe("模型超时");
    });
  });

  it("每天的调用上限：到了就不调、直接发模板版；模拟模型不占额度，标 SIMULATED", async () => {
    await inRolledBackTx(async (tx) => {
      const used = await tx.llmCall.count({ where: { model: { not: "simulated" }, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } });
      await tx.llmCall.create({ data: { purpose: "alerts", model: "fake-model", ok: true, latencyMs: 10 } });
      let called = 0;
      const counting: LlmClient = { model: "fake-model", simulated: false, chat: async () => (called++, { content: "{}", promptTokens: 0, completionTokens: 0 }) };
      const capped = await modelWriter({ db: tx, dailyLimit: 1, client: counting })(input);
      if (used === 0) {
        expect(capped.fallbackReason).toBe("今天调用模型的次数到上限了（1 次）");
        expect(called).toBe(0);
      }
      const simulated = await modelWriter({ db: tx, dailyLimit: 1, client: createSimulatedLlmClient() })(input);
      expect(simulated).toMatchObject({ source: "SIMULATED", fallbackReason: null });
      expect(simulated.content).toContain("模拟模型生成（演示）");
      expect(simulated.content.indexOf("日结没做完")).toBeLessThan(simulated.content.indexOf("滞销机器")); // 很急的排前面
    });
  });
});
