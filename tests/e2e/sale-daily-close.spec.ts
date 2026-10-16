import { expect, test, type Page } from "@playwright/test";

// 核心链路端到端：店长登录 → 开一单（1 张钢化膜，微信收款）→ 配件库存少 1 → 日结里微信系统数多出这单的钱。
// 最后把这单作废，库存和日结恢复原样，测试可以反复跑。用的是种子里的中山路店（S001）和店长账号。

const STORE_ID = 1;
const ACCESSORY = "钢化膜（高清）";

function toFen(text: string): number {
  const m = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) throw new Error(`读不到金额：${text}`);
  return Math.round(Number(m[0]) * 100);
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill("manager");
  await page.locator('input[name="password"]').fill("demo1234");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("/");
}

async function accessoryQty(page: Page): Promise<number> {
  await page.goto(`/stock?storeId=${STORE_ID}&tab=accessories`);
  const row = page.locator("tr", { hasText: ACCESSORY }).first();
  await expect(row).toBeVisible();
  const text = await row.locator("td").nth(3).innerText();
  return Number(text.match(/\d+/)![0]);
}

async function wechatSystemFen(page: Page): Promise<number> {
  await page.goto(`/daily-close?storeId=${STORE_ID}`);
  const row = page.locator("tr", { hasText: "微信" }).first();
  await expect(row).toBeVisible();
  return toFen(await row.locator("td").nth(1).innerText());
}

test("登录 → 开单 → 库存减 → 日结对得上（最后作废还原）", async ({ page }) => {
  await login(page);

  const qtyBefore = await accessoryQty(page);
  expect(qtyBefore).toBeGreaterThan(0);
  const wechatBefore = await wechatSystemFen(page);

  // 开单：选配件、加入、默认微信收全款、提交
  await page.goto(`/sales/new?storeId=${STORE_ID}`);
  await page.locator(".ant-select", { hasText: "选配件" }).click();
  await page.keyboard.type("钢化膜（高清）");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^加\s?入$/ }).click();
  await expect(page.getByText("本单（1 行）")).toBeVisible();
  await expect(page.getByText("收款已对上")).toBeVisible();
  await page.getByRole("button", { name: "提交开单" }).click();

  await page.waitForURL(/\/sales\/\d+$/);
  await expect(page.getByText("已完成").first()).toBeVisible();
  const orderUrl = page.url();
  const totalText = await page.locator(".ant-descriptions-item", { hasText: "应收" }).locator(".ant-descriptions-item-content").innerText();
  const totalFen = toFen(totalText);
  expect(totalFen).toBeGreaterThan(0);

  // 库存少 1、日结微信多出这单的钱
  expect(await accessoryQty(page)).toBe(qtyBefore - 1);
  expect(await wechatSystemFen(page)).toBe(wechatBefore + totalFen);

  // 作废还原（店长能作废）
  await page.goto(orderUrl);
  await page.getByRole("button", { name: /^作\s?废$/ }).click();
  await page.getByPlaceholder("作废原因").fill("端到端测试还原");
  await page.locator(".ant-popconfirm").getByRole("button", { name: /^确\s?定$/ }).click();
  await expect(page.getByText("已作废").first()).toBeVisible();

  expect(await accessoryQty(page)).toBe(qtyBefore);
  expect(await wechatSystemFen(page)).toBe(wechatBefore);
});
