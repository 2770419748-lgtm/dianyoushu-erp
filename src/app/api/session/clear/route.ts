import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/same-origin";
import { COOKIE_NAME } from "@/server/auth/token";

// 账号被停用（或删除、改过密码）后，浏览器里的登录 cookie 还在、签名也还有效。requireUser 发现这种情况
// 会跳到 /login?reason=expired（proxy 见到它不再弹回首页，免得两边来回跳），登录页再发一个 POST 到这里
// 把旧 cookie 清掉（页面渲染时不能删 cookie，只有 Route Handler 和 Server Function 能）。
// 只认 POST、只认本站发的（口径第 20 节）：原来是 GET，别的网站放个链接或图片就能让人被登出。
export function POST(request: Request) {
  if (!isSameOrigin(request.headers)) return new NextResponse(null, { status: 403 });
  const response = new NextResponse(null, { status: 204 });
  response.cookies.delete(COOKIE_NAME);
  return response;
}
