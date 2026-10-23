import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 手机宽度（375）下每个页面都不能比屏幕宽（2026-10-23 复查第 80、81 条）：表格在自己的框里横向滚，整页不横着滚。
// 页面清单从 src/app/(main) 下的 page.tsx 来；带 [id] 的页面，从别的页面上的链接里找一个真地址。只看，不点按钮。

const WIDTH = 375;
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
  test(`手机宽度下页面不超宽：${who}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 812 }, isMobile: true, hasTouch: true, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    await page.goto("/login");
    await page.locator('input[name="username"]').fill(who);
    await page.locator('input[name="password"]').fill("demo1234");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => u.pathname !== "/login");
    const all = routes();
    const links = new Set<string>();
    const wide: string[] = [];
    const check = async (url: string) => {
      const m = await measure(page, url);
      m.hrefs.forEach((h) => links.add(h));
      if (m.sw > m.cw + 1) wide.push(`${url}：页面 ${m.sw}，最右边是 <${m.worst?.tag}>「${m.worst?.text ?? ""}」到 ${m.worst?.right}`);
    };
    for (const r of all.filter((x) => !x.includes("["))) await check(r);
    for (const r of all.filter((x) => x.includes("["))) {
      const re = new RegExp("^" + r.replace(/\[[^\]]+\]/g, "[^/?#]+") + "$");
      const href = [...links].find((h) => re.test(h));
      if (href) await check(href);
    }
    await context.close();
    expect(wide, wide.join("\n")).toEqual([]);
  });
}
