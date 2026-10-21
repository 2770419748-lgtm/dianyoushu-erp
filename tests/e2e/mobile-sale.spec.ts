import { expect, test } from "@playwright/test";

// 手机开单端到端（手机屏幕尺寸）：店长登录 → 手机查库存找一台在库机器 → 手机开单输入它的串号 → 现金 100 + 微信收剩下的，提交
// → 机器变已售 → 作废这单 → 机器回到在库。最后作废还原，可以反复跑。相机扫码在这里用"输入串号"代替（同一个入口）。

test.use({ viewport: { width: 390, height: 844 } });

test("手机开单：输串号加机器 → 提交 → 已售；作废后回到在库", async ({ page }) => {
  await page.goto("/login");
  // 手机输入法会把首字母自动变大写：账号框关掉自动大写，服务端也不分大小写，输成 Manager 照样能登
  await expect(page.locator('input[name="username"]')).toHaveAttribute("autocapitalize", "none");
  await page.locator('input[name="username"]').fill("Manager");
  await page.locator('input[name="password"]').fill("demo1234");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("/");

  // 手机查库存：本店在库的机器里挑第一台
  await page.goto("/m/stock?q=GB");
  const row = page.locator("div", { has: page.locator(".ant-tag", { hasText: /^在库$/ }) }).filter({ has: page.locator('a[href^="/stock/devices/"]') }).last();
  const code = (await row.locator('a[href^="/stock/devices/"]').first().innerText()).trim();
  expect(code.length).toBeGreaterThan(5);

  // 手机开单：输串号回车 → 出现在单子里 → 提交
  await page.goto("/m/sale");
  await page.waitForLoadState("networkidle");
  const input = page.getByPlaceholder("或输入串号 / 配件条码，回车");
  await expect(async () => {
    await input.fill(code);
    await input.press("Enter");
    await expect(page.locator(".ant-tag", { hasText: code })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  // 拆两种收款：现金收 100，剩下的微信收（演示路径第 4 步）
  await page.getByRole("button", { name: "拆成两种收" }).click();
  await page.getByPlaceholder("收多少").fill("100");
  await page.getByRole("button", { name: "收款并提交" }).click();
  await expect(page.getByText(/开单成功/)).toBeVisible();
  await expect(page.getByText(/现金 100\.00/)).toBeVisible();
  const orderHref = await page.locator("a", { hasText: "看这张单" }).getAttribute("href");
  expect(orderHref).toMatch(/^\/sales\/\d+$/);

  // 机器已售
  await page.goto(`/m/stock?q=${code}`);
  await expect(page.getByText(`没找到“${code}”`)).toBeVisible(); // 已售的机器不在查库存结果里

  // 作废还原：打开刚才那张单
  await page.goto(orderHref!);
  await page.waitForLoadState("networkidle");
  await expect(async () => {
    await page.getByRole("button", { name: /^作\s?废$/ }).click();
    await expect(page.getByPlaceholder("作废原因")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.getByPlaceholder("作废原因").fill("手机开单端到端还原");
  await page.locator(".ant-popconfirm").getByRole("button", { name: /^确\s?定$/ }).click();
  await expect(page.getByText("已作废").first()).toBeVisible();

  await page.goto(`/m/stock?q=${code}`);
  await expect(page.locator(".ant-tag", { hasText: /^在库$/ })).toBeVisible();
});
