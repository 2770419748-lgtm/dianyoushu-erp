import { defineConfig } from "@playwright/test";

// 端到端测试：只盖一条核心链路（登录 → 开单 → 库存减 → 日结对得上）。
// 本机用自带的 Edge（channel: "msedge"），不另外下载浏览器；CI 里用 Playwright 自带的 Chromium（环境变量 CI 有值时）。
// 要先有数据库和演示数据（pnpm db:reset）。
// 开发服务器已经开着就直接用，没开就自动 pnpm dev 起一个。
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    channel: process.env.CI ? undefined : "msedge",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
