import "server-only";
import { ALERT_KIND_LABELS, ALERT_THRESHOLDS, type AlertDraft, type AlertKindKey, kpiBehind, suggestTransfers, yuanText } from "@/lib/alerts";
import { formatDate } from "@/lib/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/sales-labels";
import { dailyGap, timeProgress } from "@/server/dashboard/metrics";
import type { Db } from "@/server/db-tx";
import { describeIntegrity, integrityOk, runIntegrityChecks } from "../../../prisma/integrity-checks";
import type { PrismaClient } from "@/generated/prisma/client";

// 智能提醒的规则（口径第 18 节）：每条规则一个函数，按门店算好数字，写一句话。不调模型，结果能对账、能写测试。
// 所有时间都按传进来的 now 算（测试里可以固定时间）。

const DAY_MS = 24 * 3600 * 1000;

export interface StoreInfo {
  id: number;
  code: string;
  name: string;
  regionId: number;
}

const label = (s: StoreInfo) => `${s.code} ${s.name}`;

function storeDraft(kind: AlertKindKey, store: StoreInfo, severity: 1 | 2 | 3, detail: string, link: string | null, facts: Record<string, string | number>, metric: { value: number; unit: string }): AlertDraft & { metric: { value: number; unit: string }; store: StoreInfo } {
  return { kind, scope: "STORE", storeId: store.id, regionId: null, severity, title: ALERT_KIND_LABELS[kind], detail, link, facts, metric, store, key: `${metric.value}${metric.unit}` };
}

export type StoreAlert = ReturnType<typeof storeDraft>;

/** 1. 滞销机器：在库超过 30 天 */
async function staleDevices(db: Db, stores: Map<number, StoreInfo>, now: Date): Promise<StoreAlert[]> {
  const before = new Date(now.getTime() - ALERT_THRESHOLDS.staleDays * DAY_MS);
  const rows = await db.$queryRaw<{ store_id: number; sku: string; qty: number; oldest: number }[]>`
    SELECT d.store_id, k.name AS sku, COUNT(*)::int AS qty, MAX(FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - d.created_at)) / 86400))::int AS oldest
    FROM devices d JOIN skus k ON k.id = d.sku_id
    WHERE d.status = 'IN_STOCK' AND d.created_at < ${before} AND d.store_id = ANY(${[...stores.keys()]})
    GROUP BY 1, 2 ORDER BY 1, 4 DESC, 3 DESC`;
  const byStore = new Map<number, typeof rows>();
  for (const r of rows) byStore.set(r.store_id, [...(byStore.get(r.store_id) ?? []), r]);
  return [...byStore].map(([storeId, list]) => {
    const qty = list.reduce((s, r) => s + r.qty, 0);
    const oldest = Math.max(...list.map((r) => r.oldest));
    const top = list.slice(0, 3).map((r) => `${r.sku} ${r.qty} 台`).join("、");
    return storeDraft("STALE_DEVICES", stores.get(storeId)!, qty >= 10 || oldest >= 60 ? 2 : 1, `在库超过 ${ALERT_THRESHOLDS.staleDays} 天的机器 ${qty} 台，最久的压了 ${oldest} 天，主要是 ${top}`, "/stock", { 台数: qty, 最久天数: oldest, 主要型号: top }, { value: qty, unit: "台" });
  });
}

/** 2. 配件缺货：余额低于安全库存 */
async function lowAccessories(db: Db, stores: Map<number, StoreInfo>): Promise<StoreAlert[]> {
  const rows = await db.$queryRaw<{ store_id: number; sku: string; qty: number; safety: number }[]>`
    SELECT a.store_id, k.name AS sku, a.qty, k.safety_qty AS safety
    FROM accessory_stocks a JOIN skus k ON k.id = a.sku_id
    WHERE k.safety_qty > 0 AND k.is_active AND a.qty < k.safety_qty AND a.store_id = ANY(${[...stores.keys()]})
    ORDER BY a.store_id, a.qty ASC, k.name`;
  const byStore = new Map<number, typeof rows>();
  for (const r of rows) byStore.set(r.store_id, [...(byStore.get(r.store_id) ?? []), r]);
  return [...byStore].map(([storeId, list]) => {
    const top = list.slice(0, 3).map((r) => `${r.sku}（剩 ${r.qty}，安全库存 ${r.safety}）`).join("、");
    return storeDraft("LOW_ACCESSORY", stores.get(storeId)!, list.some((r) => r.qty === 0) ? 2 : 1, `${list.length} 种配件低于安全库存：${top}`, "/stock", { 种数: list.length, 最缺的: top }, { value: list.length, unit: "种" });
  });
}

/** 3. KPI 落后：本月销售额完成率比时间进度低 5 个百分点以上（和看板同一套算法） */
async function kpiBehindStores(db: Db, stores: Map<number, StoreInfo>, now: Date): Promise<StoreAlert[]> {
  const today = formatDate(now);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const monthStart = new Date(`${today.slice(0, 8)}01`);
  const end = new Date(today);
  const ids = [...stores.keys()];
  const [targets, sales, refunds] = await Promise.all([
    db.kpiTarget.findMany({ where: { storeId: { in: ids }, year: y, month: m } }),
    db.$queryRaw<{ store_id: number; v: bigint }[]>`SELECT store_id, SUM(total_fen)::bigint AS v FROM sales_orders WHERE status = 'COMPLETED' AND biz_date >= ${monthStart} AND biz_date <= ${end} AND store_id = ANY(${ids}) GROUP BY 1`,
    db.$queryRaw<{ store_id: number; v: bigint }[]>`SELECT store_id, SUM(refund_fen)::bigint AS v FROM return_orders WHERE biz_date >= ${monthStart} AND biz_date <= ${end} AND store_id = ANY(${ids}) GROUP BY 1`,
  ]);
  const progress = timeProgress(today);
  const out: StoreAlert[] = [];
  for (const t of targets) {
    if (t.salesTargetFen <= 0) continue;
    const actual = Number(sales.find((r) => r.store_id === t.storeId)?.v ?? 0) - Number(refunds.find((r) => r.store_id === t.storeId)?.v ?? 0);
    const rate = actual / t.salesTargetFen;
    if (!kpiBehind(rate, progress)) continue;
    const gap = dailyGap(t.salesTargetFen, actual, today);
    const ratePct = Math.round(rate * 100);
    const progressPct = Math.round(progress * 100);
    const need = yuanText(gap.needPerDay);
    const per = yuanText(gap.actualPerDay);
    out.push(
      storeDraft(
        "KPI_BEHIND",
        stores.get(t.storeId)!,
        progressPct - ratePct >= 15 ? 3 : 2,
        `本月销售额完成 ${ratePct}%，时间已经过了 ${progressPct}%；剩 ${gap.remainingDays} 天每天要卖 ${need} 元（现在日均 ${per} 元）`,
        "/dashboard",
        { 完成率: `${ratePct}%`, 时间进度: `${progressPct}%`, 剩余天数: gap.remainingDays, 每天要卖元: need, 现在日均元: per },
        { value: 1, unit: "家" },
      ),
    );
  }
  return out;
}

/** 4. 日结没做完：昨天有营业、日结没确认；或者确认了有差额（按收款方式分别看：现金多 500、微信少 500 也要提醒） */
async function dailyClose(db: Db, stores: Map<number, StoreInfo>, now: Date): Promise<StoreAlert[]> {
  const yesterday = new Date(new Date(formatDate(now)).getTime() - DAY_MS);
  const ids = [...stores.keys()];
  const [active, closes] = await Promise.all([
    db.$queryRaw<{ store_id: number }[]>`
      SELECT store_id FROM sales_orders WHERE biz_date = ${yesterday} AND store_id = ANY(${ids})
      UNION SELECT store_id FROM return_orders WHERE biz_date = ${yesterday} AND store_id = ANY(${ids})`,
    db.dailyClose.findMany({ where: { bizDate: yesterday, storeId: { in: ids } }, include: { lines: { select: { method: true, diffFen: true } } } }),
  ]);
  const out: StoreAlert[] = [];
  const day = formatDate(yesterday);
  for (const { store_id } of active) {
    const close = closes.find((c) => c.storeId === store_id);
    const store = stores.get(store_id)!;
    if (!close || close.status !== "CONFIRMED") {
      out.push({ ...storeDraft("DAILY_CLOSE", store, 3, `${day} 的日结还没确认，先核对实收再确认`, "/daily-close", { 日期: day }, { value: 1, unit: "家" }), key: `${day}没确认` });
      continue;
    }
    const off = close.lines.filter((l) => (l.diffFen ?? 0) !== 0);
    if (off.length > 0) {
      const text = off.map((l) => `${PAYMENT_METHOD_LABELS[l.method]}${l.diffFen! > 0 ? "多" : "少"} ${yuanText(Math.abs(l.diffFen!))} 元`).join("、");
      out.push({ ...storeDraft("DAILY_CLOSE", store, 3, `${day} 的日结实收和系统对不上，${text}，查一下原因`, "/daily-close", { 日期: day, 差额: text }, { value: 1, unit: "家" }), key: `${day}差额${text}` });
    }
  }
  return out;
}

/** 5. 调拨没收货：发出超过 3 天（提醒收货店） */
async function pendingTransfers(db: Db, stores: Map<number, StoreInfo>, now: Date): Promise<StoreAlert[]> {
  const rows = await db.transferOrder.findMany({
    where: { status: "SHIPPED", shippedAt: { lt: new Date(now.getTime() - ALERT_THRESHOLDS.transferDays * DAY_MS) }, toStoreId: { in: [...stores.keys()] } },
    orderBy: { shippedAt: "asc" },
    select: { id: true, orderNo: true, toStoreId: true, shippedAt: true, fromStore: { select: { name: true } } },
  });
  const byStore = new Map<number, typeof rows>();
  for (const r of rows) byStore.set(r.toStoreId, [...(byStore.get(r.toStoreId) ?? []), r]);
  return [...byStore].map(([storeId, list]) => {
    const first = list[0]!;
    const days = Math.floor((now.getTime() - first.shippedAt!.getTime()) / DAY_MS);
    return storeDraft("TRANSFER_PENDING", stores.get(storeId)!, 2, `${list.length} 张调拨单发出超过 ${ALERT_THRESHOLDS.transferDays} 天还没收货，最早的是${first.fromStore.name}发来的 ${first.orderNo}（${days} 天）`, `/transfers/${first.id}`, { 张数: list.length, 最早单号: first.orderNo, 最久天数: days }, { value: list.length, unit: "张" });
  });
}

/** 6. 盘点没确认：建了超过 2 天 */
async function openStocktakes(db: Db, stores: Map<number, StoreInfo>, now: Date): Promise<StoreAlert[]> {
  const rows = await db.stocktake.findMany({
    where: { status: "IN_PROGRESS", createdAt: { lt: new Date(now.getTime() - ALERT_THRESHOLDS.stocktakeDays * DAY_MS) }, storeId: { in: [...stores.keys()] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, stocktakeNo: true, storeId: true, createdAt: true },
  });
  const byStore = new Map<number, typeof rows>();
  for (const r of rows) byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r]);
  return [...byStore].map(([storeId, list]) => {
    const first = list[0]!;
    const days = Math.floor((now.getTime() - first.createdAt.getTime()) / DAY_MS);
    return storeDraft("STOCKTAKE_OPEN", stores.get(storeId)!, 1, `${list.length} 张盘点单建了超过 ${ALERT_THRESHOLDS.stocktakeDays} 天还没确认，最早的 ${first.stocktakeNo}（${days} 天）`, `/stocktakes/${first.id}`, { 张数: list.length, 最早单号: first.stocktakeNo, 最久天数: days }, { value: list.length, unit: "张" });
  });
}

/** 7. 回收机没处理：回收的旧机放了超过 7 天还没转良品 */
async function idleTradeIns(db: Db, stores: Map<number, StoreInfo>, now: Date): Promise<StoreAlert[]> {
  const before = new Date(now.getTime() - ALERT_THRESHOLDS.tradeInDays * DAY_MS);
  const rows = await db.$queryRaw<{ store_id: number; qty: number; oldest: number }[]>`
    SELECT store_id, COUNT(*)::int AS qty, MAX(FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - created_at)) / 86400))::int AS oldest
    FROM devices WHERE status = 'RECYCLED' AND created_at < ${before} AND store_id = ANY(${[...stores.keys()]}) GROUP BY 1`;
  return rows.map((r) =>
    storeDraft("TRADE_IN_IDLE", stores.get(r.store_id)!, 1, `${r.qty} 台回收机放了超过 ${ALERT_THRESHOLDS.tradeInDays} 天还没检测转良品，最久的 ${r.oldest} 天`, "/trade-ins", { 台数: r.qty, 最久天数: r.oldest }, { value: r.qty, unit: "台" }),
  );
}

/** 8. 待审批：要店长批的给门店，要总部批的给总部（不挂门店的请假、报销也算总部的） */
async function pendingApprovals(db: Db, stores: Map<number, StoreInfo>, now: Date, withHq: boolean): Promise<{ store: StoreAlert[]; hq: AlertDraft | null }> {
  const inStores = { storeId: { in: [...stores.keys()] } };
  const rows = await db.approvalRequest.groupBy({ by: ["storeId", "approverRole"], where: { status: "PENDING", ...(withHq ? { OR: [inStores, { storeId: null }] } : inStores) }, _count: { _all: true }, _min: { createdAt: true } });
  const store: StoreAlert[] = [];
  let hqCount = 0;
  for (const r of rows) {
    if (r.approverRole === "HQ" || r.storeId === null) {
      hqCount += r._count._all;
      continue;
    }
    const hours = r._min.createdAt ? Math.floor((now.getTime() - r._min.createdAt.getTime()) / 3600000) : 0;
    store.push(storeDraft("APPROVAL_PENDING", stores.get(r.storeId)!, 2, `${r._count._all} 张审批单等店长批，最早的等了 ${hours} 小时`, "/approvals", { 张数: r._count._all, 最久小时: hours }, { value: r._count._all, unit: "张" }));
  }
  const hq = withHq && hqCount > 0 ? { kind: "APPROVAL_PENDING" as const, scope: "HQ" as const, storeId: null, regionId: null, severity: 2 as const, title: ALERT_KIND_LABELS.APPROVAL_PENDING, detail: `${hqCount} 张审批单等总部批`, link: "/approvals", facts: { 张数: hqCount }, key: `${hqCount}张` } : null;
  return { store, hq };
}

/** 9. 调拨建议（区域、总部） */
async function transferSuggestions(db: Db, stores: Map<number, StoreInfo>, now: Date): Promise<ReturnType<typeof suggestTransfers>> {
  const ids = [...stores.keys()];
  const before = new Date(now.getTime() - ALERT_THRESHOLDS.staleDays * DAY_MS);
  const from30 = new Date(new Date(formatDate(now)).getTime() - 29 * DAY_MS);
  const [stock, sold] = await Promise.all([
    db.$queryRaw<{ store_id: number; model: string; in_stock: number; stale: number }[]>`
      SELECT d.store_id, pm.name AS model, COUNT(*)::int AS in_stock, COUNT(*) FILTER (WHERE d.created_at < ${before})::int AS stale
      FROM devices d JOIN skus k ON k.id = d.sku_id JOIN product_models pm ON pm.id = k.model_id
      WHERE d.status = 'IN_STOCK' AND d.store_id = ANY(${ids}) GROUP BY 1, 2`,
    db.$queryRaw<{ store_id: number; model: string; qty: number }[]>`
      SELECT o.store_id, pm.name AS model, SUM(si.qty)::int AS qty
      FROM sales_order_items si JOIN sales_orders o ON o.id = si.order_id JOIN skus k ON k.id = si.sku_id JOIN product_models pm ON pm.id = k.model_id
      WHERE o.status = 'COMPLETED' AND si.device_id IS NOT NULL AND o.biz_date >= ${from30} AND o.store_id = ANY(${ids}) GROUP BY 1, 2`,
  ]);
  const keys = new Set([...stock.map((r) => `${r.store_id}|${r.model}`), ...sold.map((r) => `${r.store_id}|${r.model}`)]);
  const rows = [...keys].map((key) => {
    const [storeId, model] = [Number(key.split("|")[0]), key.slice(key.indexOf("|") + 1)];
    const s = stores.get(storeId)!;
    const st = stock.find((r) => r.store_id === storeId && r.model === model);
    return { storeId, storeName: label(s), regionId: s.regionId, model, inStock: st?.in_stock ?? 0, stale: st?.stale ?? 0, sold30: sold.find((r) => r.store_id === storeId && r.model === model)?.qty ?? 0 };
  });
  return suggestTransfers({ rows });
}

function suggestionDraft(scope: "REGION" | "HQ", regionId: number | null, list: ReturnType<typeof suggestTransfers>): AlertDraft {
  const lines = list.map((s) => `${s.model}：${s.from.storeName}压了 ${s.from.stale} 台，${s.to.storeName}近 30 天卖了 ${s.to.sold30} 台、现在没货`);
  return { kind: "TRANSFER_SUGGEST", scope, storeId: null, regionId: scope === "REGION" ? regionId : null, severity: 1, title: ALERT_KIND_LABELS.TRANSFER_SUGGEST, detail: `建议调货：${lines.join("；")}`, link: "/transfers/new", facts: { 条数: list.length, 明细: lines.join("；") }, key: lines.join("；") };
}

/** 门店的提醒汇总到区域、总部：几家店、合计多少、最多的几家 */
function aggregate(kind: AlertKindKey, scope: "REGION" | "HQ", regionId: number | null, items: StoreAlert[]): AlertDraft {
  const sorted = [...items].sort((a, b) => b.metric.value - a.metric.value || a.store.id - b.store.id);
  const unit = sorted[0]!.metric.unit;
  const total = sorted.reduce((s, i) => s + i.metric.value, 0);
  const top = sorted.slice(0, scope === "HQ" ? 5 : 3).map((i) => (unit === "家" ? `${label(i.store)}（${i.detail.split("，")[0]}）` : `${label(i.store)} ${i.metric.value} ${unit}`));
  const detail = unit === "家" ? `${items.length} 家店：${top.join("；")}` : `${items.length} 家店共 ${total} ${unit}，最多的是 ${top.join("、")}`;
  return { kind, scope, storeId: null, regionId: scope === "REGION" ? regionId : null, severity: Math.max(...items.map((i) => i.severity)) as 1 | 2 | 3, title: ALERT_KIND_LABELS[kind], detail, link: null, facts: { 店数: items.length, 合计: total, 明细: top.join("；") }, key: sorted.map((i) => `${i.store.id}:${i.key}`).join(",") };
}

/**
 * 跑一遍全部规则。storeIds 给了就只算这几家店（店长点“立即生成”），不出区域和总部的汇总。
 * 返回门店、区域、总部三层的提醒。
 */
export async function collectAlerts(db: Db, now: Date, options: { storeIds?: number[] } = {}): Promise<{ stores: StoreInfo[]; drafts: AlertDraft[] }> {
  const list = await db.store.findMany({ where: { isActive: true, ...(options.storeIds ? { id: { in: options.storeIds } } : {}) }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, regionId: true } });
  const stores = new Map(list.map((s) => [s.id, s]));
  if (stores.size === 0) return { stores: [], drafts: [] };
  const full = !options.storeIds;
  const [stale, low, kpi, close, transfers, stocktakes, tradeIns, approvals] = await Promise.all([
    staleDevices(db, stores, now),
    lowAccessories(db, stores),
    kpiBehindStores(db, stores, now),
    dailyClose(db, stores, now),
    pendingTransfers(db, stores, now),
    openStocktakes(db, stores, now),
    idleTradeIns(db, stores, now),
    pendingApprovals(db, stores, now, full),
  ]);
  const storeItems = [...stale, ...low, ...kpi, ...close, ...transfers, ...stocktakes, ...tradeIns, ...approvals.store];
  const drafts: AlertDraft[] = storeItems.map((i) => ({ kind: i.kind, scope: i.scope, storeId: i.storeId, regionId: i.regionId, severity: i.severity, title: i.title, detail: i.detail, link: i.link, facts: i.facts, key: i.key }));
  if (!full) return { stores: list, drafts };

  // 区域：辖区各店按类汇总（待审批区域经理管不了，不汇总）+ 调拨建议；总部：全部门店按类汇总 + 调拨建议 + 要总部批的 + 对账自检
  const suggestions = await transferSuggestions(db, stores, now);
  const kinds = [...new Set(storeItems.map((i) => i.kind))];
  for (const regionId of [...new Set(list.map((s) => s.regionId))]) {
    for (const kind of kinds) {
      if (kind === "APPROVAL_PENDING") continue;
      const items = storeItems.filter((i) => i.kind === kind && i.store.regionId === regionId);
      if (items.length > 0) drafts.push(aggregate(kind, "REGION", regionId, items));
    }
    const mine = suggestions.filter((s) => s.regionId === regionId);
    if (mine.length > 0) drafts.push(suggestionDraft("REGION", regionId, mine));
  }
  for (const kind of kinds) drafts.push(aggregate(kind, "HQ", null, storeItems.filter((i) => i.kind === kind)));
  if (suggestions.length > 0) drafts.push(suggestionDraft("HQ", null, suggestions));
  if (approvals.hq) {
    const existing = drafts.findIndex((d) => d.scope === "HQ" && d.kind === "APPROVAL_PENDING");
    if (existing >= 0) {
      const d = drafts[existing]!;
      drafts[existing] = { ...d, detail: `${d.detail}；另外 ${approvals.hq.detail}`, facts: { ...d.facts, 等总部批: approvals.hq.facts.张数! }, key: `${d.key}+${approvals.hq.key}` };
    } else drafts.push(approvals.hq);
  }
  const checks = await runIntegrityChecks(db as unknown as PrismaClient);
  if (!integrityOk(checks)) {
    const total = Object.values(checks).reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0);
    drafts.push({ kind: "INTEGRITY", scope: "HQ", storeId: null, regionId: null, severity: 3, title: ALERT_KIND_LABELS.INTEGRITY, detail: `对账自检有对不上的：${describeIntegrity(checks)}跑一下 pnpm db:check 看明细`, link: "/logs", facts: { 处数: total }, key: describeIntegrity(checks) });
  }
  return { stores: list, drafts };
}
