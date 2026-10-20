import "server-only";
import { isWecomWebhookUrl, truncateUtf8 } from "@/lib/alerts";

// 推到企业微信门店群（群机器人，口径第 18 节）。ALERT_PUSH_ENABLED=1 才真发；没打开时只记“演示：没有真发”。
// 地址只认企业微信官方的 webhook（数据库也有 CHECK），markdown 超过 4096 字节截断，失败重试一次。

export type PushResult = { status: "SENT" } | { status: "SIMULATED" } | { status: "NONE" } | { status: "FAILED"; error: string };

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export function pushEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ALERT_PUSH_ENABLED === "1";
}

export async function pushToWecomGroup(url: string | null, markdown: string, options: { transport?: Transport; enabled?: boolean } = {}): Promise<PushResult> {
  if (!url) return { status: "NONE" };
  if (!isWecomWebhookUrl(url)) return { status: "FAILED", error: "群机器人地址不对（只认 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）" };
  if (!(options.enabled ?? pushEnabled())) return { status: "SIMULATED" };
  const transport = options.transport ?? ((u, init) => fetch(u, init));
  const body = JSON.stringify({ msgtype: "markdown", markdown: { content: truncateUtf8(markdown) } });
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await transport(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8000) });
      const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
      if (res.ok && data.errcode === 0) return { status: "SENT" };
      lastError = `企业微信返回 ${res.status}${data.errcode !== undefined ? `，错误码 ${data.errcode}：${data.errmsg ?? ""}` : ""}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { status: "FAILED", error: lastError.slice(0, 300) };
}
