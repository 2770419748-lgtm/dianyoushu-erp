import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// 权限矩阵端到端（口径第 1 节、第 20 节）：四种角色逐个打开主要页面，能看的正常显示，不该看的显示“没有权限”（403 页）。
// 只读，不改数据。真正的拦截在服务层（有服务层测试），这里核对页面上看到的和口径一致。

type Role = "hq" | "regional" | "manager" | "staff";
const ALL: Role[] = ["hq", "regional", "manager", "staff"];

// allow：能打开的角色；skip：这个角色不测（看他管不管那家店，另外测）
const PAGES: { path: string; allow: Role[]; skip?: Role[] }[] = [
  { path: "/purchase", allow: ["hq"] }, // 采购单只有总部
  { path: "/org", allow: ["hq"] },
  { path: "/logs", allow: ["hq"] },
  { path: "/kpi", allow: ["hq"] },
  { path: "/approvals/rules", allow: ["hq"] },
  { path: "/subsidy/policies", allow: ["hq"] },
  { path: "/carrier/settlements", allow: ["hq"] },
  { path: "/dashboard", allow: ["hq", "regional", "manager"] },
  { path: "/finance/pnl", allow: ["hq", "regional", "manager"] },
  { path: "/hr/employees", allow: ["hq", "regional", "manager"] },
  { path: "/daily-close", allow: ["hq", "regional", "manager"] },
  { path: "/sales/new", allow: ["hq", "manager", "staff"] }, // 区域经理只看不做
  { path: "/transfers/new", allow: ["hq", "manager"] },
  { path: "/stock", allow: ALL },
  { path: "/me", allow: ALL },
  // 数据范围：5 号店属于 2 号区域，1 号店店长、1 号区域经理都看不到它的看板
  { path: "/dashboard?storeId=5", allow: ["hq"], skip: ["staff"] },
];

for (const role of ALL) {
  test(`权限矩阵：${role}`, async ({ page }) => {
    await login(page, role);
    for (const p of PAGES) {
      if (p.skip?.includes(role)) continue;
      await page.goto(p.path);
      await page.waitForLoadState("domcontentloaded");
      const denied = page.locator(".ant-result-403");
      if (p.allow.includes(role)) {
        await expect(denied, `${role} 应该能打开 ${p.path}`).toHaveCount(0);
        expect(new URL(page.url()).pathname, `${role} 打开 ${p.path} 不该被跳走（比如跳回登录页）`).toBe(p.path.split("?")[0]);
        await expect(page.getByText("这一页出了点问题"), `${role} 打开 ${p.path} 不该报错`).toHaveCount(0);
      } else {
        await expect(denied, `${role} 不该能打开 ${p.path}`).toHaveCount(1);
      }
    }
  });
}
