import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { query } from "./helpers";

// 手机宽度下每个页面都不能比屏幕宽（2026-10-23 复查第 80～83 条）：表格在自己的框里横向滚，整页不横着滚。
// 页面清单从 src/app/(main) 下的 page.tsx 来。带参数的页面（/sales/[id] 这种）：先从页面上的链接里找真地址
// （本身就是清单里的固定页面的不算，比如 /sales/new），找不到就从库里挑一个这个角色看得到的；
// 两样都没有、又不在“故意不扫”里的，报错——不能悄悄跳过；打开以后核对停在的就是这个地址、不是“没有权限”“找不到”页。
// 这个角色本来进不了的写进 CANNOT_ENTER。只看，不点按钮。

const WIDTH = Number(process.env.NARROW_WIDTH ?? 320); // 老款小屏手机；放得下 320 就放得下 360、375、390
const MAIN = path.join(__dirname, "../../src/app/(main)");

function routes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name === "page.tsx") {
        const rel = path.relative(MAIN, dir).split(path.sep).filter((s) => !/^\(.*\)$/.test(s)).join("/");
        out.push("/" + rel);
      }
    }
  };
  walk(MAIN);
  return out.map((r) => (r === "/" ? "/" : r.replace(/\/$/, ""))).filter((r) => !["/expired", "/first-password"].includes(r));
}

type Who = { id: number; storeId: number | null };

/** 带参数的页面从库里挑一个这个角色看得到的；返回参数值，没有返回 null */
const FROM_DB: Record<string, (w: Who) => [string, unknown[]]> = {
  "/sales/[id]": (w) => [`SELECT id::text AS v FROM sales_orders WHERE ($1::int IS NULL OR salesperson_id = $1) ORDER BY id DESC LIMIT 1`, [w.storeId ? w.id : null]],
  "/sales/[id]/return": (w) => [
    `SELECT o.id::text AS v FROM sales_orders o WHERE o.status = 'COMPLETED' AND ($1::int IS NULL OR o.salesperson_id = $1)
       AND EXISTS (SELECT 1 FROM sales_order_items i WHERE i.order_id = o.id AND i.returned_qty < i.qty) ORDER BY o.id DESC LIMIT 1`,
    [w.storeId ? w.id : null],
  ],
  "/customers/[id]": () => [`SELECT customer_id::text AS v FROM sales_orders WHERE customer_id IS NOT NULL ORDER BY id DESC LIMIT 1`, []],
  "/repairs/[id]": (w) => [`SELECT id::text AS v FROM repair_orders WHERE ($1::int IS NULL OR store_id = $1) ORDER BY id DESC LIMIT 1`, [w.storeId]],
  "/stock/devices/[code]": (w) => [`SELECT code AS v FROM devices WHERE ($1::int IS NULL OR store_id = $1) ORDER BY id DESC LIMIT 1`, [w.storeId]],
  "/stocktakes/[id]": (w) => [`SELECT id::text AS v FROM stocktakes WHERE ($1::int IS NULL OR store_id = $1) ORDER BY id DESC LIMIT 1`, [w.storeId]],
  "/transfers/[id]": (w) => [`SELECT id::text AS v FROM transfer_orders WHERE ($1::int IS NULL OR from_store_id = $1 OR to_store_id = $1) ORDER BY id DESC LIMIT 1`, [w.storeId]],
  "/approvals/[id]": (w) => [`SELECT id::text AS v FROM approval_requests WHERE ($1::int IS NULL OR requested_by_id = $1) ORDER BY id DESC LIMIT 1`, [w.storeId ? w.id : null]],
  "/invoices/[id]": () => [`SELECT id::text AS v FROM invoices ORDER BY id DESC LIMIT 1`, []],
  "/notices/[id]": () => [`SELECT id::text AS v FROM notices ORDER BY id DESC LIMIT 1`, []],
  "/carrier/settlements/[id]": () => [`SELECT id::text AS v FROM carrier_settlements ORDER BY id DESC LIMIT 1`, []],
  "/purchase/[id]": () => [`SELECT id::text AS v FROM purchase_orders ORDER BY id DESC LIMIT 1`, []],
  "/purchase/[id]/edit": () => [`SELECT id::text AS v FROM purchase_orders WHERE status = 'DRAFT' ORDER BY id DESC LIMIT 1`, []],
  "/stores/[id]": (w) => [`SELECT id::text AS v FROM stores WHERE ($1::int IS NULL OR id = $1) ORDER BY id LIMIT 1`, [w.storeId]],
  "/setup/import/[id]": () => [`SELECT id::text AS v FROM import_batches WHERE kind IN ('DEVICES', 'ACCESSORIES') ORDER BY id DESC LIMIT 1`, []],
};

/** 这个角色本来就进不了的带参数页面（口径第 1 节权限矩阵），不扫；同一个页面 hq 那一遍扫过 */
const CANNOT_ENTER: Record<string, Record<string, string>> = {
  staff: {
    "/purchase/[id]": "店员不管采购",
    "/purchase/[id]/edit": "店员不管采购",
    "/carrier/settlements/[id]": "运营商结算单只有总部看",
    "/setup/import/[id]": "数据导入只有总部做",
  },
};

/** 演示数据里可能一条都没有的，没有就不扫（返回原因）；别的找不到要报错 */
const MAY_BE_EMPTY: Record<string, (w: Who) => string | null> = {
  "/purchase/[id]/edit": () => "演示数据里可能没有草稿采购单",
  "/setup/import/[id]": () => "演示数据里没有期初入库单（端到端导入测试跑完会删掉）",
  // 演示数据不生成盘点单、调拨单（盘点、调拨的端到端测试排在后面才建）：刚灌的库里这个角色一张都看不到时不扫；
  // 只要库里有这个角色看得到的（hq 看全部，门店账号看本店），上面 FROM_DB 就会挑出来照扫
  "/stocktakes/[id]": (w) => (w.storeId ? "这家店还没有盘点单" : "库里还没有盘点单"),
  "/transfers/[id]": (w) => (w.storeId ? "这家店还没有调拨单" : "库里还没有调拨单"),
};

async function measure(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle" });
  return page.evaluate(() => {
    const de = document.documentElement;
    let worst: { right: number; tag: string; text: string } | null = null;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > de.clientWidth + 1 && (!worst || r.right > worst.right)) worst = { right: Math.round(r.right), tag: el.tagName.toLowerCase(), text: ((el as HTMLElement).innerText || "").trim().slice(0, 16) };
    }
    // 打开的是“没有权限”“找不到”“出错了”这类结果页（antd Result 403/404/500/error），不算扫到了那一页
    const blocked = document.querySelector(".ant-result-403, .ant-result-404, .ant-result-500, .ant-result-error");
    return {
      sw: de.scrollWidth,
      cw: de.clientWidth,
      worst,
      path: location.pathname,
      blocked: blocked ? ((blocked.querySelector(".ant-result-title") ?? blocked) as HTMLElement).innerText.trim() : null,
      hrefs: [...document.querySelectorAll("a[href^='/']")].map((a) => a.getAttribute("href")!.split("?")[0]!),
    };
  });
}

for (const who of ["hq", "staff"]) {
  test(`手机宽度（${WIDTH}）下页面不超宽：${who}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const [user] = await query<{ id: number; store_id: number | null }>("SELECT id, store_id FROM users WHERE username = $1", [who]);
    const w: Who = { id: user!.id, storeId: user!.store_id };
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 780 }, isMobile: true, hasTouch: true, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    await page.goto("/login");
    await page.locator('input[name="username"]').fill(who);
    await page.locator('input[name="password"]').fill("demo1234");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => u.pathname !== "/login");
    const all = routes();
    const fixed = new Set(all.filter((x) => !x.includes("[")));
    const links = new Set<string>();
    const wide: string[] = [];
    const missing: string[] = [];
    const notReal: string[] = [];
    const check = async (url: string) => {
      const m = await measure(page, url);
      m.hrefs.forEach((h) => links.add(h));
      if (m.sw > m.cw + 1) wide.push(`${url}：页面 ${m.sw}，最右边是 <${m.worst?.tag}>「${m.worst?.text ?? ""}」到 ${m.worst?.right}`);
      return m;
    };
    for (const r of fixed) await check(r);
    for (const r of all.filter((x) => x.includes("["))) {
      if (CANNOT_ENTER[who]?.[r]) continue;
      const re = new RegExp("^" + r.replace(/\[[^\]]+\]/g, "[^/?#]+") + "$");
      let url = [...links].find((h) => re.test(h) && !fixed.has(h));
      if (!url && FROM_DB[r]) {
        const [sql, params] = FROM_DB[r](w);
        const [row] = await query<{ v: string }>(sql, params);
        if (row) url = r.replace(/\[[^\]]+\]/, encodeURIComponent(row.v));
      }
      if (url) {
        // 核对真打开了这一页（复查第 89 条）：挑错了地址、被跳走、看到的是“没有权限”，量的就是别的页面
        const m = await check(url);
        if (decodeURIComponent(m.path) !== decodeURIComponent(url)) notReal.push(`${r}：打开 ${url} 停在了 ${m.path}`);
        else if (m.blocked) notReal.push(`${r}：打开 ${url} 看到的是「${m.blocked}」`);
      } else if (!MAY_BE_EMPTY[r]?.(w)) missing.push(r);
    }
    await context.close();
    expect(missing, `这几个带参数的页面没找到能打开的地址：${missing.join("、")}`).toEqual([]);
    expect(notReal, `这几个带参数的页面打开的不是那一页（这个角色进不了的写进 CANNOT_ENTER）：\n${notReal.join("\n")}`).toEqual([]);
    expect(wide, wide.join("\n")).toEqual([]);
  });
}

// 窄屏（< 992）侧栏收着时，点页面里的链接换到别的组的页面：左边不能浮出那一组的子菜单盖住内容（复查第 97 条）。
// 换组要走页面里的链接（客户端跳转），page.goto 是整页重新加载，碰不到这个问题
for (const width of [390, 800]) {
  test(`窄屏（${width}）侧栏收着时换到别的组的页面、后退，左边不浮出子菜单`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    const noPopup = () => expect(page.locator(".ant-menu-submenu-popup:visible")).toHaveCount(0);
    await page.goto("/login");
    await page.locator('input[name="username"]').fill("hq");
    await page.locator('input[name="password"]').fill("demo1234");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => u.pathname !== "/login");
    await page.goto("/sales", { waitUntil: "networkidle" }); // “销售”组
    await page.locator(".ant-breadcrumb a", { hasText: "首页" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await page.locator(".ant-layout-content a[href='/stock']").first().click(); // 首页卡片“库存”：换到“库存”组
    await page.waitForURL((u) => u.pathname === "/stock");
    await page.waitForLoadState("networkidle");
    await noPopup();
    // 浏览器后退两次回到“销售”组的页面
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/");
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/sales");
    await page.waitForLoadState("networkidle");
    await noPopup();
    // 点左上角打开菜单：展开的是“销售”那一组
    await page.locator(".ant-layout-sider-zero-width-trigger").click();
    await expect(page.locator(".ant-layout-sider .ant-menu-submenu-open > .ant-menu-submenu-title")).toHaveText(["销售"]);
    await context.close();
  });
}
