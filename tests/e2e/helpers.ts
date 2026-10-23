import "dotenv/config";
import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

// 端到端测试共用的小工具（口径第 20 节补的权限矩阵、退货、调拨、盘点几条用）。
// 用种子里的演示账号（密码 demo1234）和门店：1 号店 S001（店长 manager）、2 号店 S002。

export const S001 = 1;
export const S002 = 2;
export const ACCESSORY = "钢化膜（高清）";

export function toFen(text: string): number {
  const m = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) throw new Error(`读不到金额：${text}`);
  return Math.round(Number(m[0]) * 100);
}

export async function login(page: Page, username: string) {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill("demo1234");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("/");
}

/** 某家店某个配件的库存数（按名字搜，别依赖默认排序） */
export async function accessoryQty(page: Page, storeId: number, name = ACCESSORY): Promise<number> {
  await page.goto(`/stock?storeId=${storeId}&tab=accessories&q=${encodeURIComponent(name)}`);
  const row = page.locator("tr", { hasText: name }).first();
  await expect(row).toBeVisible();
  const text = await row.locator("td").nth(3).innerText();
  return Number(text.match(/\d+/)![0]);
}

/** 点 Ant Design 的按钮：页面刚出来时按钮可能还没接上点击事件（前端还在加载），点到出现下一步为止 */
export async function clickUntil(page: Page, click: () => Promise<void>, next: () => Promise<void>) {
  await expect(async () => {
    await click();
    await next();
  }).toPass({ timeout: 15_000 });
}

/** 点开 Popconfirm 气泡里的“确定” */
export async function confirmPop(page: Page) {
  await page.locator(".ant-popconfirm").last().getByRole("button", { name: /^确\s?定$/ }).click();
}

/** 只读查库（测试拿来对答案；Playwright 按 CommonJS 跑，Prisma 生成的客户端加载不了，用 pg） */
export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return (await db.query(sql, params)).rows as T[];
  } finally {
    await db.end();
  }
}
