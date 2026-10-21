// 上线前的配置检查：生产环境（next start / Docker）启动时调用，有问题就拒绝启动，不带着弱配置上线。
// 本机开发（pnpm dev）不拦，只在生产环境生效。纯函数，方便单元测试。

import { isValidAesKey } from "./wecom/crypto";
import { WECOM_REQUIRED_ENV } from "./wecom/config";
import { LLM_REQUIRED_ENV } from "./llm/config";

export const MIN_SESSION_SECRET_LENGTH = 32;

// .env.example 和 CI 里的占位值，原样拿去上线等于没设
const PLACEHOLDER_SECRETS = ["换成你自己的随机字符串", "ci-only-placeholder-not-a-real-secret"];

export function checkProductionEnv(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const secret = env.SESSION_SECRET ?? "";
  if (!secret) {
    problems.push("没有设置 SESSION_SECRET");
  } else if (PLACEHOLDER_SECRETS.includes(secret)) {
    problems.push("SESSION_SECRET 还是示例里的占位值，要换成自己生成的随机串");
  } else if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET 太短（${secret.length} 个字符），至少要 ${MIN_SESSION_SECRET_LENGTH} 个；可以用 node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" 生成`);
  }
  if (!env.DATABASE_URL) problems.push("没有设置 DATABASE_URL");
  else if (/:(你的密码|password|postgres)@/.test(env.DATABASE_URL)) problems.push("DATABASE_URL 里的数据库密码还是示例值或默认值");
  // 演示模式必须写明：演示站写 1，真给门店用写 0（docs/部署.md 上线前检查清单第 1 条）。不写就拒绝，免得真店忘了关演示模式
  if (env.DEMO_MODE === undefined || env.DEMO_MODE === "") problems.push("没有写明 DEMO_MODE：演示站写 1，真给门店用写 0");
  else if (env.DEMO_MODE !== "0" && env.DEMO_MODE !== "1") problems.push(`DEMO_MODE 只能是 0 或 1，现在是 "${env.DEMO_MODE}"`);
  // 企业微信真对接：一个自建应用的 Secret + 回调的 Token、EncodingAESKey 缺一不可
  if (env.WECOM_ENABLED !== undefined && env.WECOM_ENABLED !== "" && env.WECOM_ENABLED !== "0" && env.WECOM_ENABLED !== "1") problems.push(`WECOM_ENABLED 只能是 0 或 1，现在是 "${env.WECOM_ENABLED}"`);
  if (env.WECOM_ENABLED === "1") {
    const missing = WECOM_REQUIRED_ENV.filter((key) => !env[key]);
    if (missing.length > 0) problems.push(`开了企业微信对接（WECOM_ENABLED=1），但没有设置 ${missing.join("、")}`);
    if (env.WECOM_CALLBACK_AES_KEY && !isValidAesKey(env.WECOM_CALLBACK_AES_KEY)) problems.push("WECOM_CALLBACK_AES_KEY 格式不对：应该是企业微信后台给的 43 位 EncodingAESKey");
    if (env.WECOM_AGENT_ID && !/^\d+$/.test(env.WECOM_AGENT_ID)) problems.push("WECOM_AGENT_ID 应该是数字（企业微信后台自建应用的 AgentId）");
  }
  // 大模型（智能提醒，口径第 18 节）：打开了就要地址、密钥、模型名；地址要 https（密钥不能明文走网络）
  if (env.LLM_ENABLED !== undefined && env.LLM_ENABLED !== "" && env.LLM_ENABLED !== "0" && env.LLM_ENABLED !== "1") problems.push(`LLM_ENABLED 只能是 0 或 1，现在是 "${env.LLM_ENABLED}"`);
  if (env.LLM_ENABLED === "1") {
    const missing = LLM_REQUIRED_ENV.filter((key) => !env[key]);
    if (missing.length > 0) problems.push(`开了大模型（LLM_ENABLED=1），但没有设置 ${missing.join("、")}`);
    if (env.LLM_BASE_URL && !env.LLM_BASE_URL.startsWith("https://")) problems.push("LLM_BASE_URL 要用 https 地址（比如 https://api.deepseek.com）");
  }
  if (env.ALERT_PUSH_ENABLED !== undefined && env.ALERT_PUSH_ENABLED !== "" && env.ALERT_PUSH_ENABLED !== "0" && env.ALERT_PUSH_ENABLED !== "1") problems.push(`ALERT_PUSH_ENABLED 只能是 0 或 1，现在是 "${env.ALERT_PUSH_ENABLED}"`);
  return problems;
}

/** 不拦启动、但启动时要提醒的配置 */
export function checkProductionWarnings(env: Record<string, string | undefined>): string[] {
  const warnings: string[] = [];
  if (env.DEMO_MODE === "1") warnings.push("DEMO_MODE=1：这是演示站（演示账号受保护、可以每日重置数据）。真给门店用要改成 0。");
  if (env.DEMO_MODE === "1" && env.WECOM_ENABLED !== "1") warnings.push("企业微信是模拟模式：页面上的加好友、欢迎语都是模拟的，不连企业微信。");
  if (env.DEMO_MODE === "1" && env.LLM_ENABLED !== "1") warnings.push("智能提醒用的是模拟模型：今日待办是程序排序加固定建议写的，不连大模型。");
  return warnings;
}

/** 生产环境启动时调用（src/instrumentation.ts）：不合格就打印原因、退出进程，服务器起不来 */
export function enforceProductionEnv(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== "production") return;
  for (const warning of checkProductionWarnings(env)) console.warn(`[店有数 ERP] 提醒：${warning}`);
  const problems = checkProductionEnv(env);
  if (problems.length === 0) return;
  console.error(["[店有数 ERP] 配置不合格，拒绝启动：", ...problems.map((p) => `  - ${p}`)].join("\n"));
  process.exit(1);
}
