// 上线前的配置检查：生产环境（next start / Docker）启动时调用，有问题就拒绝启动，不带着弱配置上线。
// 本机开发（pnpm dev）不拦，只在生产环境生效。纯函数，方便单元测试。

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
  return problems;
}

/** 生产环境启动时调用（src/instrumentation.ts）：不合格就打印原因、退出进程，服务器起不来 */
export function enforceProductionEnv(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const problems = checkProductionEnv(env);
  if (problems.length === 0) return;
  console.error(["[店有数 ERP] 配置不合格，拒绝启动：", ...problems.map((p) => `  - ${p}`)].join("\n"));
  process.exit(1);
}
