import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { type AlertScopeKey, digestSignature, MANAGER_ONLY_KINDS, scopeKeyOf } from "@/lib/alerts";
import { isDateKey } from "@/lib/attendance";
import { formatDate } from "@/lib/format";
import type { CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { writeAudit } from "@/server/audit";
import { type Db, withTx } from "@/server/db-tx";
import { type PushResult, pushToWecomGroup } from "./push";
import { type DigestOutput, type DigestWriter, getDigestWriter } from "./digest-writer";
import { collectAlerts } from "./rules";
import { llmConfig } from "@/server/llm/config";

export { templateWriter, modelWriter } from "./digest-writer";
export type { DigestInput, DigestOutput, DigestWriter } from "./digest-writer";

// 智能提醒（口径第 18 节）：跑规则 → 存命中的提醒 → 每个范围（门店、区域、总部）写一份今日待办 → 发系统内消息、推门店群。
// 今日待办由 writer 写（digest-writer.ts）：模型写、程序校验，不行就改发模板版。

export class AlertError extends Error {}

function bizDateOf(now: Date): Date {
  return new Date(formatDate(now));
}

function dayText(d: Date): string {
  const [, m, day] = formatDate(d).split("-").map(Number);
  return `${m} 月 ${day} 日`;
}

/** 今日待办的范围：门店分店长版（全部）和店员版（不含 KPI、日结），区域、总部各一份 */
type DigestScope = { key: string; itemKey: string; scope: AlertScopeKey; id: number | null; name: string; audience: "MANAGER" | "STAFF" | "ALL"; push: boolean };

/** 这一份今日待办发给谁：门店的店长版给店长、店员版给店员；区域给区域经理；总部给总部 */
async function recipients(db: Db, s: DigestScope) {
  const where: Prisma.UserWhereInput =
    s.scope === "STORE" ? { storeId: s.id, role: s.audience === "STAFF" ? "STAFF" : "STORE_MANAGER" } : s.scope === "REGION" ? { regionId: s.id, role: "REGIONAL_MANAGER" } : { role: "HQ" };
  return db.user.findMany({ where: { ...where, isActive: true }, select: { id: true } });
}

const ALERT_LOCK_NS = -79; // 咨询锁命名空间（见 attendance-service.ts 的列表）：同一份今日待办同时只有一个在写

/**
 * 跑一遍：storeIds 给了只算这几家店（店长点“立即生成”），否则全部门店 + 各区域 + 总部。
 * 同一天再跑：命中的更新、已经没有的删掉；今日待办命中的东西（种类 + 关键数字）变了才重写、才重新标未读、才再推门店群——
 * “等了几小时”“压了几天”这种随时间变的数字不算变，模型每次措辞不同也不算。两次同时跑，同一份待办排队写，后到的看到已经一样就不推。
 */
export async function runAlerts(options: { db?: Db; now?: Date; storeIds?: number[]; writer?: DigestWriter; push?: (url: string | null, markdown: string) => Promise<PushResult> } = {}) {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const writer = options.writer ?? getDigestWriter();
  const push = options.push ?? ((url, md) => pushToWecomGroup(url, md));
  const bizDate = bizDateOf(now);
  const full = !options.storeIds;
  const { stores, drafts } = await collectAlerts(db, now, { storeIds: options.storeIds });
  const regions = full ? await db.region.findMany({ where: { isActive: true }, select: { id: true, name: true } }) : [];
  const scopes: DigestScope[] = [
    ...stores.flatMap((s) => [
      { key: `store:${s.id}`, itemKey: `store:${s.id}`, scope: "STORE" as const, id: s.id, name: `${s.code} ${s.name}`, audience: "MANAGER" as const, push: false },
      { key: `store-staff:${s.id}`, itemKey: `store:${s.id}`, scope: "STORE" as const, id: s.id, name: `${s.code} ${s.name}`, audience: "STAFF" as const, push: true }, // 门店群里有店员，推店员版
    ]),
    ...regions.map((r) => ({ key: `region:${r.id}`, itemKey: `region:${r.id}`, scope: "REGION" as const, id: r.id, name: r.name, audience: "ALL" as const, push: false })),
    ...(full ? [{ key: "hq", itemKey: "hq", scope: "HQ" as const, id: null, name: "总部", audience: "ALL" as const, push: false }] : []),
  ];

  // 1. 命中的提醒
  for (const d of drafts) {
    const data = { scope: d.scope, storeId: d.storeId, regionId: d.regionId, severity: d.severity, title: d.title, detail: d.detail, link: d.link, facts: d.facts as Prisma.InputJsonValue };
    await db.alertItem.upsert({ where: { bizDate_kind_scopeKey: { bizDate, kind: d.kind, scopeKey: scopeKeyOf(d) } }, create: { bizDate, kind: d.kind, scopeKey: scopeKeyOf(d), ...data }, update: data });
  }
  const keep = drafts.map((d) => ({ kind: d.kind, scopeKey: scopeKeyOf(d) }));
  await db.alertItem.deleteMany({ where: { bizDate, scopeKey: { in: [...new Set(scopes.map((s) => s.itemKey))] }, ...(keep.length > 0 ? { NOT: { OR: keep } } : {}) } });

  // 2. 每个范围一份今日待办、消息、推送
  const webhooks = new Map((await db.store.findMany({ where: { id: { in: stores.map((s) => s.id) } }, select: { id: true, wecomWebhookUrl: true } })).map((s) => [s.id, s.wecomWebhookUrl]));
  const report = { items: drafts.length, digests: 0, changed: 0, notified: 0, pushed: { SENT: 0, SIMULATED: 0, NONE: 0, FAILED: 0 } as Record<PushResult["status"], number>, sources: { MODEL: 0, SIMULATED: 0, TEMPLATE: 0 } as Record<DigestOutput["source"], number> };
  const written = new Map<string, DigestOutput>(); // 店长版、店员版命中的一样时，店员版直接用店长版写好的，不再调一次模型
  for (const s of scopes) {
    const items = drafts.filter((d) => scopeKeyOf(d) === s.itemKey && !(s.audience === "STAFF" && MANAGER_ONLY_KINDS.includes(d.kind)));
    if (items.length === 0) {
      await db.alertDigest.deleteMany({ where: { bizDate, scopeKey: s.key } }); // 今天的事都处理完了，消息一起删（级联）
      continue;
    }
    const title = `${s.name} 今日待办（${dayText(now)}）`;
    const signature = digestSignature(items);
    const before = await db.alertDigest.findUnique({ where: { bizDate_scopeKey: { bizDate, scopeKey: s.key } }, select: { signature: true } });
    let out: DigestOutput | null = null;
    if (before?.signature !== signature) {
      out = written.get(`${s.itemKey}|${signature}`) ?? (await writer({ scope: s.scope, title, items })); // 写的时候不占锁（模型可能要等十几秒）
      written.set(`${s.itemKey}|${signature}`, out);
    }
    const users = await recipients(db, s);
    const body = `${items.length} 件事：${[...items].sort((a, b) => b.severity - a.severity).slice(0, 3).map((i) => i.title).join("、")}${items.length > 3 ? " 等" : ""}`;
    const result = await withTx(db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ALERT_LOCK_NS}::int, hashtext(${s.key}))`;
      const current = await tx.alertDigest.findUnique({ where: { bizDate_scopeKey: { bizDate, scopeKey: s.key } }, select: { id: true, signature: true } });
      const changed = current?.signature !== signature && out !== null;
      let digestId = current?.id ?? null;
      if (changed) {
        const data = { scope: s.scope, storeId: s.scope === "STORE" ? s.id : null, regionId: s.scope === "REGION" ? s.id : null, title, content: out!.content, source: out!.source, fallbackReason: out!.fallbackReason, signature, itemCount: items.length, generatedAt: now };
        digestId = (await tx.alertDigest.upsert({ where: { bizDate_scopeKey: { bizDate, scopeKey: s.key } }, create: { bizDate, scopeKey: s.key, ...data }, update: data, select: { id: true } })).id;
      }
      if (digestId === null) return null; // 同时跑的另一次还没写完、这次又没写：交给那一次
      const created = await tx.notification.createMany({ data: users.map((u) => ({ userId: u.id, digestId: digestId!, title: `今日待办：${s.name}`, body, link: `/alerts?digest=${digestId}` })), skipDuplicates: true });
      await tx.notification.deleteMany({ where: { digestId, userId: { notIn: users.map((u) => u.id) } } }); // 调走、停用、换了角色的人不再收
      if (changed) await tx.notification.updateMany({ where: { digestId }, data: { body, readAt: null } });
      return { digestId, changed, notified: created.count };
    });
    if (!result) continue;
    report.digests++;
    report.notified += result.notified;
    if (!result.changed) continue;
    report.changed++;
    report.sources[out!.source]++;
    if (s.push && s.id !== null) {
      const pushed = await push(webhooks.get(s.id) ?? null, out!.content);
      report.pushed[pushed.status]++;
      await db.alertDigest.update({ where: { id: result.digestId }, data: { pushStatus: pushed.status, pushError: pushed.status === "FAILED" ? pushed.error : null, pushedAt: pushed.status === "SENT" ? now : null } });
    }
  }
  return report;
}

/** 页面上的“立即生成”：店长只生成本店，总部全部 */
export async function runAlertsNow(user: CurrentUser) {
  if (user.role === "STORE_MANAGER") {
    if (!user.storeId) throw new AlertError("你还没分配门店");
    const report = await runAlerts({ storeIds: [user.storeId] });
    await writeAudit({ userId: user.id, action: "alerts.run", detail: { scope: `store:${user.storeId}`, ...report } as never });
    return report;
  }
  if (user.role !== "HQ") throw new AlertError("只有店长和总部能立即生成");
  const report = await runAlerts();
  await writeAudit({ userId: user.id, action: "alerts.run", detail: { scope: "all", ...report } as never });
  return report;
}

// ---------- 消息（顶栏小铃铛） ----------

export async function listMyNotifications(userId: number) {
  const [unread, items] = await Promise.all([
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, take: 8, select: { id: true, title: true, body: true, link: true, readAt: true, updatedAt: true } }),
  ]);
  return { unread, items };
}

export type MyNotifications = Awaited<ReturnType<typeof listMyNotifications>>;

export async function markNotificationsRead(userId: number, ids: number[] | "all") {
  await prisma.notification.updateMany({ where: { userId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) }, data: { readAt: new Date() } });
}

// ---------- 智能提醒页 ----------

/** 我能看的今日待办：店员店长本店；区域经理本区域和辖区各店；总部全部 */
async function visibleDigests(user: CurrentUser): Promise<Prisma.AlertDigestWhereInput> {
  switch (user.role) {
    case "STAFF":
      return { scopeKey: `store-staff:${user.storeId ?? 0}` }; // 店员看店员版（不含 KPI、日结）
    case "STORE_MANAGER":
      return { scopeKey: `store:${user.storeId ?? 0}` };
    case "REGIONAL_MANAGER": {
      const storeIds = (await prisma.store.findMany({ where: { regionId: user.regionId ?? 0 }, select: { id: true } })).map((s) => s.id);
      return { OR: [{ scopeKey: `region:${user.regionId ?? 0}` }, { scope: "STORE", storeId: { in: storeIds }, scopeKey: { startsWith: "store:" } }] };
    }
    case "HQ":
      return { NOT: { scopeKey: { startsWith: "store-staff:" } } }; // 店员版是店长版去掉几类，总部看店长版就够了
  }
}

export async function getAlertsPage(user: CurrentUser, query: { date?: string; digestId?: number }) {
  const date = isDateKey(query.date) ? new Date(query.date) : bizDateOf(new Date()); // 2026-13-45、2026-02-30 这种不是真日期的按今天
  const where = await visibleDigests(user);
  const digests = await prisma.alertDigest.findMany({
    where: { ...where, bizDate: date },
    orderBy: [{ scope: "desc" }, { scopeKey: "asc" }],
    select: { id: true, scope: true, scopeKey: true, title: true, content: true, source: true, fallbackReason: true, itemCount: true, pushStatus: true, pushError: true, generatedAt: true },
  });
  // 店员版的命中项就是本店的、去掉 KPI 和日结
  const itemKey = (key: string) => key.replace(/^store-staff:/, "store:");
  const scopeKeys = digests.map((d) => itemKey(d.scopeKey));
  const staffView = user.role === "STAFF";
  const rawItems = await prisma.alertItem.findMany({
    where: { bizDate: date, scopeKey: { in: scopeKeys }, ...(staffView ? { kind: { notIn: MANAGER_ONLY_KINDS } } : {}) },
    orderBy: [{ severity: "desc" }, { id: "asc" }],
    select: { id: true, kind: true, scope: true, scopeKey: true, severity: true, title: true, detail: true, link: true },
  });
  const items = staffView ? rawItems.map((i) => ({ ...i, scopeKey: i.scopeKey.replace(/^store:/, "store-staff:") })) : rawItems;
  if (query.digestId) await prisma.notification.updateMany({ where: { userId: user.id, digestId: query.digestId, readAt: null }, data: { readAt: new Date() } });
  return {
    date: formatDate(date),
    // 没用模型的原因（可能带服务商的报错原话）只给总部看；别人只知道这份是模板发的
    digests: user.role === "HQ" ? digests : digests.map((d) => ({ ...d, fallbackReason: d.fallbackReason ? "按规则模板发的" : null })),
    items,
    canRun: user.role === "STORE_MANAGER" || user.role === "HQ",
    selected: query.digestId && digests.some((d) => d.id === query.digestId) ? query.digestId : (digests[0]?.id ?? null),
    llm: user.role === "HQ" ? await llmUsage() : null,
  };
}

/** 总部看：现在用的哪种写法、今天调了几次模型、用了多少 token、最近的调用（只记成没成和 token，不存提示和回答） */
async function llmUsage() {
  const cfg = llmConfig();
  const since = new Date(new Date(formatDate(new Date())).getTime() - 8 * 3600 * 1000);
  const [today, recent] = await Promise.all([
    prisma.llmCall.groupBy({ by: ["ok"], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { promptTokens: true, completionTokens: true } }),
    prisma.llmCall.findMany({ orderBy: { id: "desc" }, take: 10, select: { id: true, model: true, ok: true, promptTokens: true, completionTokens: true, latencyMs: true, error: true, createdAt: true } }),
  ]);
  return {
    mode: cfg.mode,
    model: cfg.mode === "real" ? cfg.model : cfg.mode === "simulated" ? "模拟模型" : null,
    dailyLimit: cfg.dailyLimit,
    calls: today.reduce((n, r) => n + r._count._all, 0),
    failed: today.find((r) => !r.ok)?._count._all ?? 0,
    promptTokens: today.reduce((n, r) => n + (r._sum.promptTokens ?? 0), 0),
    completionTokens: today.reduce((n, r) => n + (r._sum.completionTokens ?? 0), 0),
    recent,
  };
}

export type AlertsPage = Awaited<ReturnType<typeof getAlertsPage>>;

export { PermissionError };
