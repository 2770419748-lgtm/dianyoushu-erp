import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getWecomClient, WecomError } from "@/server/wecom/client";
import { wecomMode } from "@/server/wecom/config";
import { agentConfigSignature } from "@/server/wecom/crypto";
import { sidebarUserFromToken } from "@/server/wecom/sidebar-service";
import { SIDEBAR_COOKIE } from "@/server/wecom/sidebar-token";

// 侧边栏 JS-SDK 的 agentConfig 签名（口径第 12 节第三步）：只给拿着侧边栏票的员工签，只签本站 /wecom-app 下的页面地址。

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (wecomMode() !== "real") return NextResponse.json({ error: "只有真对接才用 JS-SDK" }, { status: 404 });
  const user = await sidebarUserFromToken(request.cookies.get(SIDEBAR_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "侧边栏登录过期了" }, { status: 401 });
  const url = request.nextUrl.searchParams.get("url") ?? "";
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return NextResponse.json({ error: "页面地址不对" }, { status: 400 });
  }
  if (!page.pathname.startsWith("/wecom-app/")) return NextResponse.json({ error: "只签侧边栏的页面" }, { status: 400 });
  try {
    const ticket = await getWecomClient().getAgentJsapiTicket();
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = randomBytes(8).toString("hex");
    return NextResponse.json(
      { corpId: process.env.WECOM_CORP_ID ?? "", agentId: process.env.WECOM_AGENT_ID ?? "", timestamp, nonceStr, signature: agentConfigSignature(ticket, nonceStr, timestamp, url) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof WecomError) return NextResponse.json({ error: error.message }, { status: 502 });
    throw error;
  }
}
