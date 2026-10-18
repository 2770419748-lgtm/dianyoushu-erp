import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifySessionToken } from "@/server/auth/token";

// 请求入口做三件事：
// 1. 坏的 % 编码地址直接 404；
// 2. 看一眼登录 cookie：没登录的去登录页，已登录的别再进登录页（只是“乐观检查”，账号是否有效在页面和服务层查库确认）；
// 3. 给页面加内容安全策略（CSP），限制页面只能运行本站发出的脚本，防注入（XSS）。

/**
 * CSP：每个请求生成一个随机 nonce，Next.js 会读到请求头里的 CSP，自动把 nonce 加到它自己的脚本上；
 * 不带这个 nonce 的脚本（比如被注入进页面的）浏览器一律不执行。'strict-dynamic' 让带 nonce 的脚本再加载的代码块
 * （页面按需加载的 chunk、扫码库）也能运行。
 * 样式放宽成 'unsafe-inline'：Ant Design 的样式是运行时注入的 <style>，图表、扫码库也会写 style 属性；
 * 样式被注入的危害远小于脚本，取舍记录里写了。
 * 开发环境多一个 'unsafe-eval'：React 开发模式用 eval 还原报错堆栈，生产环境不需要。
 * 没加 upgrade-insecure-requests：备案前用 http://服务器IP 演示时，它会把请求强行升级成 https 导致打不开。
 */
function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function nextWithCsp(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp); // Next.js 从这里取 nonce
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp); // 浏览器按这个执行
  return response;
}

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
    return session ? NextResponse.redirect(new URL("/", request.url)) : nextWithCsp(request);
  }
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return nextWithCsp(request);
}

export const config = {
  // 图标、清单、robots.txt 不用登录也要能取到（浏览器装 PWA、搜索引擎读 robots 时不带登录态）；
  // /api/health 是健康检查，Docker 和外部拨测不带登录态
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|manifest.webmanifest|icons/|api/health).*)"],
};
