import { expect, test, type Page } from "@playwright/test";
import { ACCESSORY, clickUntil, confirmPop, login, query, S001, S002 } from "./helpers";

// 调拨端到端（口径第 5 节、第 20 节）：1 号店店长申请把 1 张钢化膜调到 2 号店并发出，总部收货；
// 两家店的配件数一减一加。最后总部把这张膜原样调回去，两家店的数还原，可以反复跑（调拨单留着）。

async function qty(storeId: number): Promise<number> {
  const rows = await query<{ qty: number }>("SELECT a.qty FROM accessory_stocks a JOIN skus s ON s.id = a.sku_id WHERE a.store_id = $1 AND s.name = $2", [storeId, ACCESSORY]);
  return rows[0]?.qty ?? 0;
}

/** 新建调拨：从 fromStoreId 调 1 张膜到 toLabel 这家店，返回调拨单详情地址 */
async function applyTransfer(page: Page, fromStoreId: number, toLabel: string): Promise<string> {
  await page.goto(`/transfers/new?fromStoreId=${fromStoreId}`);
  await page.waitForLoadState("networkidle");
  await page.locator(".ant-form-item", { hasText: "收货门店" }).locator(".ant-select").click();
  await page.keyboard.type(toLabel);
  await page.keyboard.press("Enter");
  await page.locator("tr", { hasText: ACCESSORY }).getByRole("spinbutton").fill("1");
  await page.getByRole("button", { name: "提交申请" }).click();
  await page.waitForURL(/\/transfers\/\d+$/);
  return page.url();
}

async function ship(page: Page) {
  await clickUntil(
    page,
    () => page.getByRole("button", { name: /^发\s?出$/ }).click(),
    () => expect(page.locator(".ant-popconfirm")).toBeVisible({ timeout: 1000 }),
  );
  await confirmPop(page);
  await expect(page.getByText("已发出").first()).toBeVisible();
}

async function receive(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.locator(".ant-form-item", { hasText: ACCESSORY }).getByRole("spinbutton").fill("1");
  await page.getByRole("button", { name: "确认收货" }).click();
  await expect(page.getByText("已收货").first()).toBeVisible();
}

test("店长申请并发出、总部收货：两家店一减一加；再调回去还原", async ({ browser }) => {
  const before1 = await qty(S001);
  const before2 = await qty(S002);
  expect(before1).toBeGreaterThan(0);

  const manager = await browser.newPage();
  await login(manager, "manager");
  const url = await applyTransfer(manager, S001, "S002");
  await ship(manager);
  expect(await qty(S001)).toBe(before1 - 1); // 发出店发出时减

  const hq = await browser.newPage();
  await login(hq, "hq");
  await receive(hq, url);
  expect(await qty(S002)).toBe(before2 + 1); // 收货店收货时加

  // 总部原样调回去
  const back = await applyTransfer(hq, S002, "S001");
  await ship(hq);
  await receive(hq, back);
  expect(await qty(S001)).toBe(before1);
  expect(await qty(S002)).toBe(before2);
});
