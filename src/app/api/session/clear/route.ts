import { NextResponse } from "next/server";
import { COOKIE_NAME } from "@/server/auth/token";

// 账号被停用（或删除）后，浏览器里的登录 cookie 还在、签名也还有效：
// 登录页看到 cookie 会跳回首页，首页查库发现账号已停用又跳登录页，来回死循环。
// 所以 requireUser 发现“有 cookie 但账号用不了”时先跳到这里，把 cookie 清掉再去登录页。
// （页面渲染时不能删 cookie，只有 Route Handler 和 Server Function 能。）
//
// 跳转用相对地址：部署在 Docker / 反向代理后面时，request.url 里是服务器自己的地址（0.0.0.0:3000），
// 拼成绝对地址会把浏览器带到打不开的地方；相对地址由浏览器按当前域名补全。
export function GET() {
  const response = new NextResponse(null, { status: 307, headers: { Location: "/login?reason=expired" } });
  response.cookies.delete(COOKIE_NAME);
  return response;
}
