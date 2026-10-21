// 大模型的开关和配置（口径第 18 节）。纯函数，读环境变量，配置检查和测试都能用。

type Env = Record<string, string | undefined>;

export type LlmMode = "real" | "simulated" | "off";

export const LLM_REQUIRED_ENV = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const;

export function llmConfig(env: Env = process.env) {
  const real = env.LLM_ENABLED === "1" && LLM_REQUIRED_ENV.every((key) => !!env[key]);
  const mode: LlmMode = real ? "real" : env.DEMO_MODE === "0" ? "off" : "simulated";
  const limit = Number(env.LLM_DAILY_LIMIT);
  const timeout = Number(env.LLM_TIMEOUT_MS);
  return {
    mode,
    baseUrl: (env.LLM_BASE_URL ?? "").replace(/\/+$/, ""),
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL ?? "",
    dailyLimit: Number.isInteger(limit) && limit > 0 ? limit : 200,
    timeoutMs: Number.isInteger(timeout) && timeout >= 1000 ? timeout : 20000,
  };
}
