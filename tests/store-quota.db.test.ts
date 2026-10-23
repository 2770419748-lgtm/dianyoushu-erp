import "dotenv/config";
import { afterAll, describe, expect, it, vi } from "vitest";

// 门店数上限不能被并发绕过（2026-10-23 复查第 68 条）：上限只剩 1 家时同时发 10 个新建，只能成 1 个。
// 要真的并发提交，不能放在回滚事务里：测完删掉建出来的门店、日志，开户信息恢复原样。

vi.hoisted(() => {
  process.env.DEMO_MODE = "0"; // 演示模式不管门店数上限
});

const { prisma } = await import("@/lib/prisma");
const { createStore, OrgError } = await import("@/server/org/org-service");

const PREFIX = "QTEST-";
let saved: { value: unknown } | null | undefined;

afterAll(async () => {
  const stores = await prisma.store.findMany({ where: { code: { startsWith: PREFIX } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { action: "store.create", entityId: { in: stores.map((s) => String(s.id)) } } });
  await prisma.store.deleteMany({ where: { code: { startsWith: PREFIX } } });
  if (saved === null) await prisma.systemSetting.deleteMany({ where: { key: "license" } });
  else if (saved) await prisma.systemSetting.update({ where: { key: "license" }, data: { value: saved.value as never } });
  await prisma.$disconnect();
});

describe("门店数上限（连本机库，真并发）", () => {
  it("只剩 1 家的名额，同时发 10 个新建只成 1 个", async (ctx) => {
    let hq;
    try {
      hq = await prisma.user.findFirst({ where: { role: "HQ", isActive: true }, orderBy: { id: "asc" } });
    } catch {
      return ctx.skip();
    }
    const region = await prisma.region.findFirst({ where: { isActive: true } });
    if (!hq || !region) return ctx.skip();
    saved = await prisma.systemSetting.findUnique({ where: { key: "license" }, select: { value: true } });
    const active = await prisma.store.count({ where: { isActive: true } });
    await prisma.systemSetting.upsert({
      where: { key: "license" },
      create: { key: "license", value: { plan: "PAID", startedOn: "2026-01-01", expiresOn: "2099-12-31", storeLimit: active + 1 } },
      update: { value: { plan: "PAID", startedOn: "2026-01-01", expiresOn: "2099-12-31", storeLimit: active + 1 } },
    });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => createStore(hq, { code: `${PREFIX}${i}`, name: `并发测试店 ${i}`, regionId: region.id })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.every((r) => r.reason instanceof OrgError && /上限/.test(r.reason.message))).toBe(true);
    expect(await prisma.store.count({ where: { isActive: true } })).toBe(active + 1);
  });
});
