// 请求是不是本站页面发出的（防别的网站借浏览器发请求，CSRF）：浏览器发 POST 时一定带 Origin，
// 拿它的主机名和这次请求的主机名比。在 Caddy 后面时主机名在 X-Forwarded-Host 里（浏览器跨站请求改不了这个头）。
// Server Function 自带这个检查，自己写的 Route Handler 要手动调。

export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
