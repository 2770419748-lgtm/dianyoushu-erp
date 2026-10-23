import { expect, test } from "@playwright/test";
import { accessoryQty, ACCESSORY, clickUntil, login, S001, toFen } from "./helpers";

// 退货端到端（口径第 5 节、第 20 节）：店长开一单（1 张钢化膜，微信收款）→ 库存少 1 → 在原单上退货（勾这一行，按原收款方式退全款）
// → 库存回到原来，原单显示已退款。退货单不作废（口径第 5 节），所以跑完库存还原、单据留着。

test("开单 → 退货：库存回来，原单显示已退款", async ({ page }) => {
  await login(page, "manager");
  const qtyBefore = await accessoryQty(page, S001);
  expect(qtyBefore).toBeGreaterThan(0);

  // 开单：选配件、加入、默认微信收全款、提交
  await page.goto(`/sales/new?storeId=${S001}`);
  await page.waitForLoadState("networkidle");
  await page.locator(".ant-select", { hasText: "选配件" }).click();
  await page.keyboard.type(ACCESSORY);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^加\s?入$/ }).click();
  await expect(page.getByText("本单（1 行）")).toBeVisible();
  await expect(page.getByText("收款已对上")).toBeVisible();
  await page.getByRole("button", { name: "提交开单" }).click();
  await page.waitForURL(/\/sales\/\d+$/);
  const orderUrl = page.url();
  const totalFen = toFen(await page.locator(".ant-descriptions-item", { hasText: "应收" }).locator(".ant-descriptions-item-content").innerText());
  expect(await accessoryQty(page, S001)).toBe(qtyBefore - 1);

  // 退货：配件这一行填退 1 件（机器才是勾选框），默认退全款、按原收款方式
  await page.goto(`${orderUrl}/return`);
  await page.waitForLoadState("networkidle");
  const row = page.locator("tr", { hasText: ACCESSORY });
  await clickUntil(
    page,
    () => row.getByRole("spinbutton").fill("1"),
    () => expect(page.getByRole("button", { name: /确认退货/ })).toBeEnabled({ timeout: 1000 }),
  );
  await expect(page.getByRole("button", { name: /确认退货/ })).toContainText((totalFen / 100).toFixed(2));
  await page.getByPlaceholder("退货原因").fill("端到端测试退货");
  await page.getByRole("button", { name: /确认退货/ }).click();
  await page.waitForURL(orderUrl);

  // 库存回来；原单还是已完成（退货不改原单状态），带着退货记录
  expect(await accessoryQty(page, S001)).toBe(qtyBefore);
  await page.goto(orderUrl);
  await expect(page.getByText("退货记录（1）")).toBeVisible();
  await expect(page.getByText(`退款 ${(totalFen / 100).toFixed(2)} 元（微信） · 端到端测试退货`)).toBeVisible();
});
