import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/current-user";
import { shouldUseSecureCookie } from "@/server/auth/session";
import { getWecomClient, WecomError } from "@/server/wecom/client";
import { buildOAuthUrl, EXTERNAL_USERID_PATTERN, wecomMode } from "@/server/wecom/config";
import { issueSidebarToken, SidebarError } from "@/server/wecom/sidebar-service";
import { SIDEBAR_COOKIE, SIDEBAR_COOKIE_PATH, SIDEBAR_STATE_COOKIE } from "@/server/wecom/sidebar-token";

// 企微侧边栏的登录入口（口径第 12 节第三步），不用 ERP 登录（src/proxy.ts 放行 /wecom-app）：
// - 真对接：没带 code 就跳企业微信网页授权；授权跳回来带 code，换成员工的企业微信账号，找到在职的 ERP 员工，发侧边栏的票。
// - 模拟模式（演示）：已经登录 ERP 的员工从“企微侧边栏”演示页点进来（?sim=1），直接按他自己发票，相当于企业微信告诉我们“这是谁”。
// 发完票跳到客户画像页；模拟模式把演示页选中的客户 id 带过去（真对接时由页面上的 JS-SDK 去拿）。

export const dynamic = "force-dynamic";

function publicOrigin(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

function message(text: string, status = 403): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function withTicket(response: NextResponse, ticket: { token: string; expiresAt: Date }): Promise<NextResponse> {
  response.cookies.set(SIDEBAR_COOKIE, ticket.token, { httpOnly: true, secure: await shouldUseSecureCookie(), sameSite: "lax", path: SIDEBAR_COOKIE_PATH, expires: ticket.expiresAt });
  response.cookies.delete({ name: SIDEBAR_STATE_COOKIE, path: SIDEBAR_COOKIE_PATH });
  return response;
}

export async function GET(request: NextRequest) {
  const mode = wecomMode();
  if (mode === "off") return message("not found", 404);
  const params = request.nextUrl.searchParams;
  const origin = publicOrigin(request);

  if (mode === "simulated") {
    const user = await getCurrentUser();
    if (!user || user.mustChangePassword) return message("先登录 ERP（第一次登录先改初始密码），再从“企微侧边栏”演示页打开");
    const externalUserid = params.get("externalUserid") ?? "";
    const target = new URL("/wecom-app/customer", origin);
    if (EXTERNAL_USERID_PATTERN.test(externalUserid)) target.searchParams.set("externalUserid", externalUserid);
    try {
      return withTicket(NextResponse.redirect(target), await issueSidebarToken({ id: user.id }));
    } catch (error) {
      if (error instanceof SidebarError) return message(error.message);
      throw error;
    }
  }

  // 真对接
  const code = params.get("code");
  if (!code) {
    const state = randomBytes(12).toString("hex");
    const url = buildOAuthUrl({ corpId: process.env.WECOM_CORP_ID ?? "", agentId: process.env.WECOM_AGENT_ID ?? "", redirectUri: `${origin}/wecom-app/auth`, state });
    const response = NextResponse.redirect(url);
    response.cookies.set(SIDEBAR_STATE_COOKIE, state, { httpOnly: true, secure: await shouldUseSecureCookie(), sameSite: "lax", path: SIDEBAR_COOKIE_PATH, maxAge: 600 });
    return response;
  }
  const state = params.get("state") ?? "";
  if (!state || state !== request.cookies.get(SIDEBAR_STATE_COOKIE)?.value) return message("授权已经过期，从企业微信聊天工具栏重新打开");
  let userid: string | null;
  try {
    userid = await getWecomClient().getUserIdByOAuthCode(code);
  } catch (error) {
    if (error instanceof WecomError) return message(`企业微信授权没成功：${error.message}`, 502);
    throw error;
  }
  if (!userid) return message("只有本企业的员工能用侧边栏");
  try {
    return withTicket(NextResponse.redirect(new URL("/wecom-app/customer", origin)), await issueSidebarToken({ wecomUserid: userid }));
  } catch (error) {
    if (error instanceof SidebarError) return message(error.message);
    throw error;
  }
}
