import { expect, test } from "@playwright/test";
import { clickUntil, confirmPop, login, query, S001 } from "./helpers";

// 盘点端到端（口径第 5 节、第 20 节）：店长给本店发起盘点（快照应有数）→ 机器按应有清单整批粘贴串号、配件按应有数逐行填 → 保存
// → 确认盘点（没有差异）→ 已确认，库存一件没动。没差异的盘点确认后不改库存，可以反复跑（盘点单留着）。
// 机器清单从库里读（页面上的机器表分页，一页 20 台）。

// 上次跑到一半失败留下的进行中盘点（同一家店同时只能有一张）先作废掉
test.beforeAll(async () => {
  await query("UPDATE stocktakes SET status = 'VOIDED', voided_at = now() WHERE store_id = $1 AND status = 'IN_PROGRESS' AND note = '端到端测试盘点'", [S001]);
});

test("发起盘点 → 录实盘 → 确认：没差异，库存不动", async ({ page }) => {
  const stockBefore = await query<{ n: string }>("SELECT COALESCE(SUM(qty), 0)::text AS n FROM accessory_stocks WHERE store_id = $1", [S001]);
  await login(page, "manager");

  // 发起
  await page.goto("/stocktakes");
  await page.waitForLoadState("networkidle");
  await clickUntil(
    page,
    () => page.getByRole("button", { name: "发起盘点" }).click(),
    () => expect(page.locator(".ant-modal")).toBeVisible({ timeout: 1000 }),
  );
  await page.locator(".ant-modal").getByPlaceholder("如 月末盘点").fill("端到端测试盘点");
  await page.locator(".ant-modal").getByRole("button", { name: /^确\s?定$|^OK$/ }).click();
  await page.waitForURL(/\/stocktakes\/\d+$/);
  const id = Number(page.url().match(/(\d+)$/)![1]);
  await page.waitForLoadState("networkidle");

  // 机器：应有清单里的串号一次粘贴进去
  const codes = await query<{ code: string }>("SELECT d.code FROM stocktake_items i JOIN devices d ON d.id = i.device_id WHERE i.stocktake_id = $1", [id]);
  if (codes.length > 0) await page.getByPlaceholder("粘贴实盘串号，一行一个").fill(codes.map((c) => c.code).join("\n"));
  // 配件：每行填应有数
  const accessoryCard = page.locator(".ant-card", { hasText: "配件（应有" });
  const rows = accessoryCard.locator("tbody tr");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const expected = (await rows.nth(i).locator("td").nth(1).innerText()).trim();
    await rows.nth(i).getByRole("spinbutton").fill(expected);
  }
  await page.getByRole("button", { name: "保存实盘" }).click();
  // 保存后进度里“已录”等于“应有”、差异 0（提示文字会带上统计，不按提示判断）
  await expect(page.getByText(/应有 (\d+) 项，已录 \1 项，差异 0 项/)).toBeVisible();

  // 确认：没有差异
  await clickUntil(
    page,
    () => page.getByRole("button", { name: "确认盘点" }).click(),
    () => expect(page.locator(".ant-popconfirm", { hasText: "没有差异" })).toBeVisible({ timeout: 2000 }),
  );
  await confirmPop(page);
  await expect(page.getByText("已确认").first()).toBeVisible();

  const [st] = await query<{ status: string; diffs: string }>(
    "SELECT s.status::text AS status, (SELECT COUNT(*) FROM stocktake_items i WHERE i.stocktake_id = s.id AND i.diff_qty <> 0)::text AS diffs FROM stocktakes s WHERE s.id = $1",
    [id],
  );
  expect(st).toEqual({ status: "CONFIRMED", diffs: "0" });
  const stockAfter = await query<{ n: string }>("SELECT COALESCE(SUM(qty), 0)::text AS n FROM accessory_stocks WHERE store_id = $1", [S001]);
  expect(stockAfter[0]!.n).toBe(stockBefore[0]!.n);
});
