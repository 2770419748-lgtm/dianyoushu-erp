import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 不开 cacheComponents：ERP 页面几乎都是按登录用户读库的动态数据，
  // 开了之后每处读 cookies/数据库都要包 Suspense，一个人维护没必要。
  // Docker 镜像里构建时设 BUILD_STANDALONE=1，产出只含运行所需文件的 .next/standalone（本机 Windows 构建不需要）。
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
