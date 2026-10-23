import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { query } from "./helpers";

// 手机宽度下每个页面都不能比屏幕宽（2026-10-23 复查第 80～83 条）：表格在自己的框里横向滚，整页不横着滚。
// 页面清单从 src/app/(main) 下的 page.tsx 来。带参数的页面（/sales/[id] 这种）：先从页面上的链接里找真地址
// （本身就是清单里的固定页面的不算，比如 /sales/new），找不到就从库里挑一个这个角色看得到的；
// 两样都没有、又不在“故意不扫”里的，报错——不能悄悄跳过。只看，不点按钮。

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

/** 演示数据里可能一条都没有的，没有就不扫（写明原因）；别的找不到要报错 */
const MAY_BE_EMPTY: Record<string, string> = {
  "/purchase/[id]/edit": "演示数据里可能没有草稿采购单",
  "/setup/import/[id]": "演示数据里没有期初入库单（端到端导入测试跑完会删掉）",
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
    return { sw: de.scrollWidth, cw: de.clientWidth, worst, hrefs: [...document.querySelectorAll("a[href^='/']")].map((a) => a.getAttribute("href")!.split("?")[0]!) };
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
    const check = async (url: string) => {
      const m = await measure(page, url);
      m.hrefs.forEach((h) => links.add(h));
      if (m.sw > m.cw + 1) wide.push(`${url}：页面 ${m.sw}，最右边是 <${m.worst?.tag}>「${m.worst?.text ?? ""}」到 ${m.worst?.right}`);
    };
    for (const r of fixed) await check(r);
    for (const r of all.filter((x) => x.includes("["))) {
      const re = new RegExp("^" + r.replace(/\[[^\]]+\]/g, "[^/?#]+") + "$");
      let url = [...links].find((h) => re.test(h) && !fixed.has(h));
      if (!url && FROM_DB[r]) {
        const [sql, params] = FROM_DB[r](w);
        const [row] = await query<{ v: string }>(sql, params);
        if (row) url = r.replace(/\[[^\]]+\]/, encodeURIComponent(row.v));
      }
      if (url) await check(url);
      else if (!MAY_BE_EMPTY[r]) missing.push(r);
    }
    await context.close();
    expect(missing, `这几个带参数的页面没找到能打开的地址：${missing.join("、")}`).toEqual([]);
    expect(wide, wide.join("\n")).toEqual([]);
  });
}
