import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifySessionToken } from "@/server/auth/token";

// 请求进来先看一眼 cookie：没登录的去登录页，已登录的别再进登录页。
// 这只是"乐观检查"，真正的用户有效性（是否停用、角色）在页面和服务层再查库确认。
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // 手拼的地址里有坏的 % 编码（如 /sales/%ZZ）：Next 进页面前解码会失败、报 500，这里先拦下回 404
  try {
    decodeURIComponent(pathname);
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  const session = await verifySessionToken(request.cookies.get(COOKIE_NAME)?.value);

  if (pathname.startsWith("/login")) {
    return session ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // 图标、清单、robots.txt 不用登录也要能取到（浏览器装 PWA、搜索引擎读 robots 时不带登录态）
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|manifest.webmanifest|icons/).*)"],
};
