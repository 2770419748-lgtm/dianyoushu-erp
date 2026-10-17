import type { NextConfig } from "next";

// 全站安全响应头（安全基线）：
// - X-Frame-Options：不许别的网站把本系统套进 iframe（防“点击劫持”）
// - X-Content-Type-Options：浏览器不乱猜文件类型
// - Referrer-Policy：跳到外站时只带域名，不带完整地址（地址里可能有单号）
// - Permissions-Policy：只允许本站用摄像头（扫码），麦克风、定位一律关
// 没加 CSP：Ant Design 的样式是运行时注入的，严格 CSP 要配 nonce，演示版先不做（取舍记录里写明）。
// HSTS 交给上线时的 Caddy（只在 HTTPS 下才有意义）。
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // 不开 cacheComponents：ERP 页面几乎都是按登录用户读库的动态数据，
  // 开了之后每处读 cookies/数据库都要包 Suspense，一个人维护没必要。
  // Docker 镜像里构建时设 BUILD_STANDALONE=1，产出只含运行所需文件的 .next/standalone（本机 Windows 构建不需要）。
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  poweredByHeader: false, // 不在响应头里暴露 "X-Powered-By: Next.js"
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
