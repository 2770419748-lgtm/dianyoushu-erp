import { NextResponse, type NextRequest } from "next/server";
import { destroySession } from "@/server/auth/session";

// 账号被停用（或删除）后，浏览器里的登录 cookie 还在、签名也还有效：
// 登录页看到 cookie 会跳回首页，首页查库发现账号已停用又跳登录页，来回死循环。
// 所以 requireUser 发现“有 cookie 但账号用不了”时先跳到这里，把 cookie 清掉再去登录页。
// （页面渲染时不能删 cookie，只有 Route Handler 和 Server Function 能。）
export async function GET(request: NextRequest) {
  await destroySession();
  return NextResponse.redirect(new URL("/login?reason=inactive", request.url));
}
