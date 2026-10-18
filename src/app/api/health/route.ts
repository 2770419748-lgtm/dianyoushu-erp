import { isDatabaseReachable } from "@/server/system-status";

// 健康检查：给 Docker 的 healthcheck 和外部拨测用，不用登录（src/proxy.ts 放行了 /api/health）。
// 数据库通返回 200，不通返回 503；不返回任何业务数据和报错细节。
export const dynamic = "force-dynamic";

export async function GET() {
  const ok = await isDatabaseReachable();
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
