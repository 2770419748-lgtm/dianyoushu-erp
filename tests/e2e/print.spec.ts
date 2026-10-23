import { expect, test, type Page } from "@playwright/test";
import { clickUntil, login, query } from "./helpers";

// 小票和保修卡（口径第 23 节）：销售单详情页点“打印小票”“打印保修卡”，新窗口打开打印页；换纸按钮可用。只读，不改数据。

test("销售单详情页打小票、保修卡", async ({ page }) => {
  test.setTimeout(120_000);
  const [order] = await query<{ id: number; order_no: string }>(
    "SELECT o.id, o.order_no FROM sales_orders o WHERE o.status = 'COMPLETED' AND EXISTS (SELECT 1 FROM sales_order_items i WHERE i.order_id = o.id AND i.device_id IS NOT NULL AND i.returned_qty = 0) ORDER BY o.id DESC LIMIT 1",
  );
  await login(page, "hq");
  await page.goto(`/sales/${order!.id}`);

  let receipt: Page | null = null;
  await clickUntil(
    page,
    async () => {
      const popup = page.waitForEvent("popup", { timeout: 3000 });
      await page.getByRole("button", { name: "打印小票" }).click();
      receipt = await popup;
    },
    async () => expect(receipt).not.toBeNull(),
  );
  // 打印页第一次打开时开发服务器要现编译（CI 上十几秒），第一个断言多等一会儿
  await expect(receipt!.getByText(order!.order_no)).toBeVisible({ timeout: 45_000 });
  await expect(receipt!.getByText("应收")).toBeVisible();
  await expect(receipt!.getByText(/机器保修到 \d{4}-\d{2}-\d{2}/)).toBeVisible();
  // 换 58mm 纸
  await receipt!.getByRole("link", { name: "58mm" }).click();
  await expect(receipt!).toHaveURL(/paper=58/);
  await expect(receipt!.getByText(order!.order_no)).toBeVisible();

  const warrantyPopup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "打印保修卡" }).click();
  const warranty = await warrantyPopup;
  await expect(warranty.getByText("保修卡").first()).toBeVisible({ timeout: 45_000 });
  await expect(warranty.getByText(order!.order_no).first()).toBeVisible();
});

test("手机宽度：销售单详情页不超出屏幕，打印按钮都点得到（复查第 80 条）", async ({ page }) => {
  const [order] = await query<{ id: number }>(
    "SELECT o.id FROM sales_orders o WHERE o.status = 'COMPLETED' AND o.customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM sales_order_items i WHERE i.order_id = o.id AND i.device_id IS NOT NULL AND i.returned_qty = 0) ORDER BY o.id DESC LIMIT 1",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "hq");
  await page.goto(`/sales/${order!.id}`);
  await expect(page.getByRole("button", { name: "打印保修卡" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const name of ["打印小票", "打印保修卡"]) {
    const box = (await page.getByRole("button", { name }).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
});
