import { expect, test } from "@playwright/test";
import { login, query } from "./helpers";

// 开户和初始化（口径第 21 节）：
// - 总部新建或重置过密码的员工，第一次登录先改密码，改完才能用别的页面；
// - 总部在“系统设置”里填公司信息。
// 用种子里的一个店员（emp 开头，不是受保护的演示账号，密码 demo1234）；前后把密码、设置恢复原样，可以反复跑。

let staff: { id: number; username: string; password_hash: string; session_version: number } | null = null;
let company: { value: unknown } | null = null;

test.beforeAll(async () => {
  [staff] = await query<NonNullable<typeof staff>>(
    "SELECT id, username, password_hash, session_version FROM users WHERE role = 'STAFF' AND is_active AND username LIKE 'emp%' ORDER BY id LIMIT 1",
  );
  [company] = await query<{ value: unknown }>("SELECT value FROM system_settings WHERE key = 'company'");
});

test.afterAll(async () => {
  if (staff) await query("UPDATE users SET password_hash = $2, session_version = $3, must_change_password = false WHERE id = $1", [staff.id, staff.password_hash, staff.session_version]);
  if (company) await query("UPDATE system_settings SET value = $1 WHERE key = 'company'", [JSON.stringify(company.value)]);
  else await query("DELETE FROM system_settings WHERE key = 'company'");
});

test("总部设的密码：第一次登录先改，改完才能用", async ({ page }) => {
  expect(staff).not.toBeNull();
  await query("UPDATE users SET must_change_password = true WHERE id = $1", [staff!.id]);
  await login(page, staff!.username);
  await expect(page.getByText("先改一下密码")).toBeVisible();
  // 换个页面也一样先改密码
  await page.goto("/sales");
  await expect(page.getByText("先改一下密码")).toBeVisible();

  await page.getByLabel("现在的密码（刚才登录用的）").fill("demo1234");
  await page.getByLabel("新密码", { exact: true }).fill("first-change-1");
  await page.getByLabel("再输一次新密码").fill("first-change-1");
  await page.getByRole("button", { name: "改密码" }).click();
  await expect(page.getByText("先改一下密码")).toBeHidden();
  const [row] = await query<{ must_change_password: boolean }>("SELECT must_change_password FROM users WHERE id = $1", [staff!.id]);
  expect(row.must_change_password).toBe(false);
});

test("总部在系统设置里填公司信息", async ({ page }) => {
  await login(page, "hq");
  await page.goto("/setup");
  await expect(page.getByText("1 公司信息和小票抬头")).toBeVisible();
  await page.getByLabel("公司名").fill("端到端测试通讯");
  await page.getByLabel("联系电话").fill("0571-8888 6666");
  await page.locator(".ant-card", { hasText: "1 公司信息和小票抬头" }).locator('button[type="submit"]').click(); // 页面上好几个“保存”，按卡片找
  await expect(page.getByText("公司信息已保存")).toBeVisible();
  const [row] = await query<{ value: { name: string; receiptTitle: string } }>("SELECT value FROM system_settings WHERE key = 'company'");
  expect(row.value).toMatchObject({ name: "端到端测试通讯", receiptTitle: "端到端测试通讯" });
});
