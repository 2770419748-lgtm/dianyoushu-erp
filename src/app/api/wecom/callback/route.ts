import { getWecomClient } from "@/server/wecom/client";
import { handleWecomCallback } from "@/server/wecom/callback-service";
import { realCallbackConfig, wecomMode } from "@/server/wecom/config";

// 企业微信回调地址（客户联系事件）：不用登录（src/proxy.ts 不拦 /api/wecom），靠验签确认是企业微信发来的。
// 只有真对接（WECOM_ENABLED=1）时打开；演示里的“模拟扫码加好友”在服务端直接调同一个处理函数，不走这个地址。

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024; // 企业微信的事件都很小，超过的直接拒收

async function handle(request: Request, method: "GET" | "POST"): Promise<Response> {
  if (wecomMode() !== "real") return new Response("not found", { status: 404 });
  let body = "";
  if (method === "POST") {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return new Response("too large", { status: 413 });
    body = await request.text();
    if (body.length > MAX_BODY_BYTES) return new Response("too large", { status: 413 });
  }
  const result = await handleWecomCallback({ method, query: new URL(request.url).searchParams, body }, { config: realCallbackConfig(), client: getWecomClient() });
  return new Response(result.body, { status: result.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export function GET(request: Request) {
  return handle(request, "GET");
}

export function POST(request: Request) {
  return handle(request, "POST");
}
