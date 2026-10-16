import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 不开 cacheComponents：ERP 页面几乎都是按登录用户读库的动态数据，
  // 开了之后每处读 cookies/数据库都要包 Suspense，一个人维护没必要。
  // 第 9 周部署用 Docker 时再加 output: "standalone"。
};

export default nextConfig;
