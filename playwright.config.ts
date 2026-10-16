import { defineConfig } from "@playwright/test";

// 端到端测试：只盖一条核心链路（登录 → 开单 → 库存减 → 日结对得上）。
// 用本机自带的 Edge（channel: "msedge"），不另外下载浏览器；要先有本机数据库和种子数据（pnpm db:seed）。
// 开发服务器已经开着就直接用，没开就自动 pnpm dev 起一个。
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    channel: "msedge",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
