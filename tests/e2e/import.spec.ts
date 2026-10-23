import { expect, test } from "@playwright/test";
import { clickUntil, login, query, S001 } from "./helpers";

// 数据导入和机型库（口径第 22 节）：总部上传在库机器表，有问题列出来、整批不进；改好后确认导入，生成期初入库单；
// 下载模板；从机型库勾一个型号建商品。测完把导入的机器、流水、导入记录和新建的商品删掉，可以反复跑。

const stamp = String(Date.now()).slice(-12);
const IMEI_A = `96${stamp}1`;
const IMEI_B = `96${stamp}2`;
let batchNo: string | null = null;

test.afterAll(async () => {
  if (batchNo) {
    const devices = await query<{ id: number }>("SELECT DISTINCT device_id AS id FROM stock_ledgers WHERE doc_no = $1 AND device_id IS NOT NULL", [batchNo]);
    await query("DELETE FROM stock_ledgers WHERE doc_no = $1", [batchNo]);
    if (devices.length) await query("DELETE FROM devices WHERE id = ANY($1::int[])", [devices.map((d) => d.id)]);
    await query("DELETE FROM import_batches WHERE batch_no = $1", [batchNo]);
  }
  await query("DELETE FROM skus WHERE name = '一加 12 12GB+256GB 岩黑' AND NOT EXISTS (SELECT 1 FROM stock_ledgers l WHERE l.sku_id = skus.id)");
  await query("DELETE FROM product_models m WHERE m.name = '一加 12' AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.model_id = m.id)");
});

test("在库机器导入：有问题整批不进；改好确认导入，生成期初入库单", async ({ page }) => {
  const [store] = await query<{ code: string }>("SELECT code FROM stores WHERE id = $1", [S001]);
  const [sku] = await query<{ barcode: string }>(
    "SELECT s.barcode FROM skus s JOIN product_models m ON m.id = s.model_id JOIN categories c ON c.id = m.category_id WHERE c.kind = 'DEVICE' AND s.is_active AND NOT s.is_service AND s.barcode IS NOT NULL ORDER BY s.id LIMIT 1",
  );
  await login(page, "hq");
  await page.goto("/setup/import");
  // 页面刚出来时前端可能还没接上点击，点到说明换成“在库机器”的为止
  await clickUntil(
    page,
    () => page.locator(".ant-segmented").getByText("在库机器", { exact: true }).click(),
    () => expect(page.getByText("生成期初入库单：机器直接在库")).toBeVisible({ timeout: 2000 }),
  );
  const fileInput = page.locator('input[type="file"]');
  const upload = async (text: string) => {
    await fileInput.setInputFiles({ name: "在库机器.csv", mimeType: "text/csv", buffer: Buffer.from(text, "utf8") });
    await page.getByRole("button", { name: "上传并检查" }).click();
  };

  // 门店编码不对：列出问题，不能确认导入
  await upload(`门店编码,条码,IMEI1,成本\nNOPE,${sku!.barcode},${IMEI_A},4000\n`);
  await expect(page.getByText("有 1 处问题，整批都不进")).toBeVisible();
  await expect(page.getByText("系统里没有门店 NOPE")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认导入" })).toHaveCount(0);

  // 改好：检查通过 → 确认导入
  await upload(`门店编码,条码,IMEI1,成本\n${store!.code},${sku!.barcode},${IMEI_A},4000\n${store!.code},${sku!.barcode},${IMEI_B},4100.5\n`);
  await expect(page.getByText("检查通过：表里 2 行")).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  const done = page.locator(".ant-alert", { hasText: /导入完成：QC\d{12}/ }); // 提示条（右上角的消息里也有这句）
  await expect(done).toBeVisible();
  batchNo = (await done.innerText()).match(/QC\d{12}/)![0];

  const devices = await query<{ code: string; status: string; cost_fen: number }>("SELECT code, status, cost_fen FROM devices WHERE code = ANY($1::text[]) ORDER BY code", [[IMEI_A, IMEI_B]]);
  expect(devices).toEqual([
    { code: IMEI_A, status: "IN_STOCK", cost_fen: 400000 },
    { code: IMEI_B, status: "IN_STOCK", cost_fen: 410050 },
  ]);

  // 历次导入里有这张单（演示数据开过销售单，没有撤销按钮），点开看明细
  const row = page.locator("tr", { hasText: batchNo });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "撤销" })).toHaveCount(0);
  await row.getByRole("link", { name: batchNo }).click();
  await expect(page.getByText(`期初入库单 ${batchNo}`)).toBeVisible();
  await expect(page.getByRole("link", { name: IMEI_A })).toBeVisible();
});

test("下载导入模板是 .xlsx", async ({ page }) => {
  await login(page, "hq");
  const res = await page.request.get("/api/import/template?kind=DEVICES");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("spreadsheetml");
  expect((await res.body()).subarray(0, 2).toString()).toBe("PK");
});

test("从机型库勾一个型号建商品", async ({ page }) => {
  await login(page, "hq");
  await page.goto("/products/library");
  const card = page.locator(".ant-card", { has: page.getByText("一加 12", { exact: true }) });
  await clickUntil(
    page,
    () => page.locator(".ant-segmented").getByText("一加", { exact: true }).click(),
    () => expect(card).toBeVisible({ timeout: 2000 }),
  );
  await card.getByText("岩黑", { exact: true }).click();
  await card.getByText("12GB+256GB", { exact: true }).click();
  await expect(page.getByText("要新建 1 个商品")).toBeVisible();
  await page.getByRole("button", { name: /^添\s?加$/ }).click();
  await expect(page.getByText(/新建商品 1 个/)).toBeVisible();
  const [sku] = await query<{ guide_price_fen: number }>("SELECT guide_price_fen FROM skus WHERE name = '一加 12 12GB+256GB 岩黑'");
  expect(sku!.guide_price_fen).toBe(429900);
});
