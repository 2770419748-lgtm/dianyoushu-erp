import "dotenv/config";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { totpAt, totpStep } from "../../src/server/auth/totp";

// 二次验证端到端（口径第 20 节）：店长在“我的”页扫码开启（这里直接读页面上的密钥算动态码），
// 退出后再登录，输完密码要输动态码：输错不让进，输对进首页。前后都把这个账号的绑定清掉，可以反复跑。
// 用种子里的 2 号店店长 emp003（不是受保护的演示账号，密码也是 demo1234）。

const USERNAME = "emp003";
// Playwright 按 CommonJS 跑测试文件，Prisma 生成的客户端加载不了，直接用 pg 清绑定
async function clearMfa() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("UPDATE users SET mfa_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL WHERE username = $1", [USERNAME]);
  await db.end();
}

test.beforeAll(clearMfa);
test.afterAll(clearMfa);

test("店长自己开二次验证；再登录要输动态码，错的不让进", async ({ page, context }) => {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill("demo1234");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("/");

  // 开启：扫码页面上有手动输入用的密钥，拿它算当前的动态码
  await page.goto("/me");
  await page.getByRole("button", { name: "开启二次验证" }).click();
  const secret = (await page.locator("code").first().innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByPlaceholder("6 位动态码").fill(totpAt(secret, totpStep(new Date())));
  await page.getByRole("button", { name: "确认开启" }).click();
  await expect(page.getByText("已开启")).toBeVisible();

  // 退出（清 cookie），重新登录：密码对了还要动态码
  await context.clearCookies();
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill("demo1234");
  await page.locator('button[type="submit"]').click();
  const codeInput = page.locator('input[name="code"]');
  await expect(codeInput).toBeVisible();
  await codeInput.fill("000000");
  await page.locator('button[type="submit"]').click(); // Ant Design 会把两个字的按钮写成“登 录”，按类型找
  await expect(page.getByText("动态码不对")).toBeVisible();
  // 刚才开启时用掉了当前时间窗的码，用下一个窗的（允许前后各差一个窗）
  await codeInput.fill(totpAt(secret, totpStep(new Date()) + 1));
  await page.locator('button[type="submit"]').click(); // Ant Design 会把两个字的按钮写成“登 录”，按类型找
  await page.waitForURL("/");
});

test("“我的”页两个标签页先后点开启：先开的那个二维码作废，说清楚", async ({ context }) => {
  await clearMfa();
  const first = await context.newPage();
  await first.goto("/login");
  await first.locator('input[name="username"]').fill(USERNAME);
  await first.locator('input[name="password"]').fill("demo1234");
  await first.locator('button[type="submit"]').click();
  await first.waitForURL("/");
  await first.goto("/me");
  await first.getByRole("button", { name: "开启二次验证" }).click();
  const oldSecret = (await first.locator("code").first().innerText()).trim();
  // 另一个标签页又点了一次开启：换了新二维码
  const second = await context.newPage();
  await second.goto("/me");
  await second.getByRole("button", { name: "开启二次验证" }).click();
  await expect(second.locator("code").first()).toBeVisible();
  // 回到第一个标签页，用旧二维码的码确认
  await first.getByPlaceholder("6 位动态码").fill(totpAt(oldSecret, totpStep(new Date())));
  await first.getByRole("button", { name: "确认开启" }).click();
  await expect(first.getByText("这个二维码已经作废了")).toBeVisible();
});
