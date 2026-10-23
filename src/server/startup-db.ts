// 应用启动时连库失败怎么办（快核第 63、64 条）：库还没起来（服务器重启时应用常比数据库先起来）就等一等；
// 密码错、库名错、没跑迁移这类等多久都不会好，直接退出并写明原因，别让人等满 2 分钟再翻日志猜。
// 纯函数，单元测试直接测；没有 "server-only"，instrumentation.ts 动态加载。

const FATAL: Record<string, string> = {
  P1000: "数据库账号或密码不对：看 .env 的 APP_DB_PASSWORD 和连接串；库建好以后只改 .env 不够，库里的密码不会跟着变（见 docs/部署.md）",
  P1003: "数据库不存在：看连接串里的库名",
  P1010: "这个账号没有权限访问这个库：看 docker/db-roles.sh 是不是跑过",
  P2021: "表不存在：还没跑迁移（docker compose run --rm tools pnpm exec prisma migrate deploy）",
  P2022: "列不存在：迁移没跑全（docker compose run --rm tools pnpm exec prisma migrate deploy）",
};

/** Prisma 的报错第一行是空的、中间是调用位置，真正的原因在最后一行；再带上错误代码 */
export function describeDbStartupError(error: unknown): { fatal: boolean; reason: string } {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  const message = error instanceof Error ? error.message : String(error);
  const last = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  const detail = [code, last].filter(Boolean).join(" ") || "未知错误";
  return FATAL[code] ? { fatal: true, reason: `${FATAL[code]}（${detail}）` } : { fatal: false, reason: detail };
}
