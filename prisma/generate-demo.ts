import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import type { DeviceStatus, LedgerDocType, PaymentMethod } from "../src/generated/prisma/enums";
import { formatDate } from "../src/lib/format";
import { describeIntegrity, integrityOk, runIntegrityChecks } from "./integrity-checks";
import { daysUntil, entitlementExpiresOn } from "../src/lib/entitlement";

// 模拟经营数据 v1（第 9 周）：10 家店、3 个月（截至昨天）的采购到货、销售、以旧换新、回收机转良品再卖、作废、退货、日结。
// 规则和真实业务一致：库存每次变动都有流水、配件余额 = 流水合计、日结系统数 = 当天收款汇总。
// 为了快，这里在内存里按"门店 × 天"顺序模拟，最后批量写库（不走一单一事务的服务层，但守同样的规则，结尾会自检）。
// 今天不生成：留给现场演示开单、日结。
// 用法：pnpm db:reset（清空 → 基础种子 → 本脚本）。单独跑本脚本要求业务单据表是空的。

const DAYS = 92;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });

// ---------- 固定种子的随机数，每次生成一模一样 ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261017);
const chance = (p: number) => rnd() < p;
const between = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
function weighted<T>(items: readonly T[], weight: (t: T) => number): T {
  const total = items.reduce((s, i) => s + weight(i), 0);
  let r = rnd() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

// ---------- 日期：营业日按北京时间 ----------
const DAY_MS = 86400000;
function bizDateOf(offsetFromToday: number): Date {
  const today = new Date(`${formatDate(new Date())}T00:00:00.000Z`);
  return new Date(today.getTime() + offsetFromToday * DAY_MS);
}
/** 某营业日北京时间 hh:mm 对应的 UTC 时刻 */
function at(bizDate: Date, hour: number, minute: number): Date {
  return new Date(bizDate.getTime() + (hour - 8) * 3600000 + minute * 60000);
}
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

// ---------- 单号 ----------
const docCounters = new Map<string, number>();
function docNo(prefix: string, bizDate: Date): string {
  const key = `${prefix}${ymd(bizDate)}`;
  const n = (docCounters.get(key) ?? 0) + 1;
  docCounters.set(key, n);
  return `${key}${String(n).padStart(4, "0")}`;
}

// ---------- 名字、手机号、机器码 ----------
const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵", "周", "吴", "徐", "孙", "马", "朱", "胡", "郭", "何", "林", "高", "罗", "郑", "梁", "谢", "宋", "唐", "韩"];
const GIVEN = ["伟", "芳", "娜", "敏", "静", "丽", "强", "磊", "洋", "勇", "艳", "杰", "涛", "明", "超", "华", "平", "刚", "文", "婷", "浩", "欣", "雪", "佳", "宇", "晨", "阳", "琳", "鹏", "颖", "凯", "倩"];
const phones = new Set<string>();
function newPhone(): string {
  for (;;) {
    const p = `1${pick(["3", "5", "7", "8", "9"])}${String(Math.floor(rnd() * 1e9)).padStart(9, "0")}`;
    if (!phones.has(p)) {
      phones.add(p);
      return p;
    }
  }
}
let imei1Seq = 10000000000;
let imei2Seq = 5000000000000;
let oldImeiSeq = 1000000000000;
const sns = new Set<string>();
function newSn(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  for (;;) {
    let s = "F";
    for (let i = 0; i < 11; i++) s += chars[Math.floor(rnd() * chars.length)];
    if (!sns.has(s)) {
      sns.add(s);
      return s;
    }
  }
}
function newDeviceCodes(apple: boolean) {
  imei1Seq += between(1, 97);
  const imei1 = `86${String(imei1Seq).padStart(13, "0")}`;
  const imei2 = !apple && chance(0.8) ? `86${String((imei2Seq += between(1, 97))).padStart(13, "0")}` : null;
  const sn = apple ? newSn() : chance(0.3) ? newSn() : null;
  return { code: imei1, sn, imei1, imei2 };
}
function oldPhoneCode(): string {
  oldImeiSeq += between(1, 97);
  return `35${String(oldImeiSeq).padStart(13, "0")}`;
}

const OLD_PHONES: { name: string; min: number; max: number }[] = [
  { name: "iPhone 11 128GB", min: 900, max: 1500 },
  { name: "iPhone 12 128GB", min: 1300, max: 2000 },
  { name: "iPhone 13 128GB", min: 1800, max: 2800 },
  { name: "iPhone 14 Pro 256GB", min: 3000, max: 4300 },
  { name: "华为 Mate 40 Pro 256GB", min: 1200, max: 2000 },
  { name: "华为 P50 256GB", min: 1000, max: 1700 },
  { name: "华为 nova 9 128GB", min: 500, max: 900 },
  { name: "小米 12 256GB", min: 700, max: 1200 },
  { name: "小米 13 256GB", min: 1100, max: 1800 },
  { name: "OPPO Reno8 256GB", min: 500, max: 900 },
  { name: "vivo X80 256GB", min: 800, max: 1400 },
  { name: "荣耀 70 256GB", min: 500, max: 900 },
];
const CONDITIONS = ["95 新", "9 成新", "9 成新", "8 成新", "有损"];
const METHOD_WEIGHTS: [PaymentMethod, number][] = [
  ["WECHAT", 45],
  ["ALIPAY", 25],
  ["CARD", 12],
  ["CASH", 10],
  ["INSTALLMENT", 6],
  ["OTHER", 2],
];

// ---------- 内存里的行（id 自己分配，最后批量写） ----------
type Row = Record<string, unknown>;
const ids = { customer: 0, po: 0, poItem: 0, receipt: 0, receiptItem: 0, tradeIn: 0, device: 0, close: 0, closeLine: 0, sale: 0, saleItem: 0, payment: 0, ret: 0, retItem: 0, ledger: 0, kpi: 0, entitlement: 0, reminder: 0 };
const out = {
  customers: [] as Row[],
  purchaseOrders: [] as Row[],
  purchaseItems: [] as Row[],
  receipts: [] as Row[],
  receiptItems: [] as Row[],
  tradeIns: [] as Row[],
  devices: [] as DeviceRec[],
  closes: [] as Row[],
  closeLines: [] as Row[],
  sales: [] as SaleRec[],
  saleItems: [] as SaleItemRec[],
  payments: [] as PaymentRec[],
  returns: [] as Row[],
  returnItems: [] as Row[],
  ledgers: [] as Row[],
  kpis: [] as Row[],
  entitlements: [] as EntitlementRec[],
  reminders: [] as Row[],
};
interface EntitlementRec {
  id: number;
  customerId: number;
  storeId: number;
  salesOrderId: number;
  salesOrderItemId: number;
  skuId: number;
  deviceId: number | null;
  startedOn: Date;
  expiresOn: Date;
  status: "ACTIVE" | "VOIDED";
  voidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DeviceRec {
  id: number;
  code: string;
  sn: string | null;
  imei1: string | null;
  imei2: string | null;
  skuId: number;
  storeId: number;
  status: DeviceStatus;
  costFen: number;
  condition: string | null;
  goodsReceiptId: number | null;
  tradeInOrderId: number | null;
  createdAt: Date;
  updatedAt: Date;
}
interface SaleRec {
  id: number;
  orderNo: string;
  storeId: number;
  customerId: number | null;
  salespersonId: number;
  status: "COMPLETED" | "VOIDED";
  bizDate: Date;
  subtotalFen: number;
  discountFen: number;
  totalFen: number;
  tradeInOrderId: number | null;
  dailyCloseId: number | null;
  note: string | null;
  voidedById: number | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface SaleItemRec {
  id: number;
  orderId: number;
  skuId: number;
  deviceId: number | null;
  qty: number;
  unitPriceFen: number;
  discountFen: number;
  lineTotalFen: number;
  costFen: number;
  returnedQty: number;
}
interface PaymentRec {
  id: number;
  salesOrderId: number | null;
  returnOrderId: number | null;
  method: PaymentMethod;
  amountFen: number;
  tradeInOrderId: number | null;
  reference: string | null;
  createdAt: Date;
}

function ledger(row: { docType: LedgerDocType; docNo: string; storeId: number; skuId: number; deviceId?: number | null; qtyDelta: number; balanceAfter?: number | null; statusBefore?: DeviceStatus | null; statusAfter?: DeviceStatus | null; operatorId: number; note?: string | null; createdAt: Date }) {
  out.ledgers.push({ id: ++ids.ledger, deviceId: null, balanceAfter: null, statusBefore: null, statusAfter: null, note: null, ...row });
}

async function main() {
  const existing = await prisma.salesOrder.count();
  if (existing > 0) {
    console.error(`已经有 ${existing} 张销售单了。模拟数据要在空库上生成，请用 pnpm db:reset（会清空再重建）。`);
    process.exit(1);
  }

  const [stores, users, skus, hq] = await Promise.all([
    prisma.store.findMany({ where: { isActive: true }, orderBy: { id: "asc" } }),
    prisma.user.findMany({ where: { isActive: true } }),
    prisma.sku.findMany({ where: { isActive: true }, include: { model: { include: { brand: true, category: true } } } }),
    prisma.user.findFirst({ where: { role: "HQ" }, orderBy: { id: "asc" } }),
  ]);
  if (!hq) throw new Error("没有总部账号，先跑 pnpm db:seed");
  const genericSku = skus.find((s) => s.name === "回收机（其他机型）");
  if (!genericSku) throw new Error("缺少“回收机（其他机型）”SKU，先跑 pnpm db:seed");

  const deviceSkus = skus.filter((s) => s.model.category.kind === "DEVICE" && s.guidePriceFen > 0);
  const accessorySkus = skus.filter((s) => s.model.category.kind === "ACCESSORY" && !s.isService);
  // 服务类商品（碎屏险、延保）：买新机的约两成加一份，不进库存，单上必须有客户
  const serviceSkus = skus.filter((s) => s.isService && s.serviceMonths);
  const serviceSkuIds = new Set(serviceSkus.map((s) => s.id));
  const SERVICE_WEIGHT: Record<string, number> = { "碎屏险 1 年": 5, "碎屏险 季度版": 3, "延保 1 年": 2 };
  const BRAND_WEIGHT: Record<string, number> = { 苹果: 3.2, 华为: 3, 小米: 2, 荣耀: 1.4, OPPO: 1.2, vivo: 1.2, 一加: 0.6, 三星: 0.4 };
  // 热销程度：品牌权重 × 价格越低越好卖 × 平板少一些
  const deviceWeight = (s: (typeof deviceSkus)[number]) =>
    (BRAND_WEIGHT[s.model.brand.name] ?? 0.5) * (s.model.category.name === "平板" ? 0.35 : 1) * Math.pow(400000 / Math.max(s.guidePriceFen, 150000), 0.9) * (s.storage && /512GB|1TB/.test(s.storage) ? 0.55 : 1);
  const accessoryWeight = (s: (typeof accessorySkus)[number]) => Math.pow(10000 / Math.max(s.guidePriceFen, 1900), 0.8);

  let customerPool: number[] = [];
  function customerFor(always: boolean): number | null {
    if (!always && !chance(0.65)) return null;
    if (customerPool.length > 50 && chance(0.25)) return pick(customerPool); // 老客户
    const id = ++ids.customer;
    const name = pick(SURNAMES) + pick(GIVEN) + (chance(0.4) ? pick(GIVEN) : "");
    out.customers.push({ id, name, phone: newPhone(), note: null });
    customerPool.push(id);
    return id;
  }

  // 每家店的体量系数：有大店有小店，看板才有差别
  const storeFactor = new Map(stores.map((s, i) => [s.id, [1.35, 1.2, 1.05, 0.95, 1.25, 0.85, 0.75, 1.1, 0.9, 0.7][i % 10]!]));

  for (const store of stores) {
    const staff = users.filter((u) => u.storeId === store.id && (u.role === "STAFF" || u.role === "STORE_MANAGER"));
    const manager = staff.find((u) => u.role === "STORE_MANAGER") ?? hq;
    if (staff.length === 0) continue;
    // 销售员能力不同：业绩排名才有区分度
    const staffSkill = new Map(staff.map((u) => [u.id, 0.6 + rnd() * 1.1]));

    const inStock = new Map<number, DeviceRec[]>(); // skuId → 在库新机
    const refurbished: DeviceRec[] = []; // 良品，可卖
    const pendingRefurb: { device: DeviceRec; day: number }[] = [];
    const accessoryBal = new Map<number, number>();
    const scheduledReturns = new Map<number, number[]>(); // 第几天 → 销售单 id
    const saleById = new Map<number, SaleRec>();

    for (let day = -DAYS; day <= -1; day++) {
      const bizDate = bizDateOf(day);
      const weekday = new Date(bizDate.getTime() + 8 * 3600000).getUTCDay();
      const dom = Number(bizDate.toISOString().slice(8, 10));
      const nextMonthFirst = new Date(Date.UTC(bizDate.getUTCFullYear(), bizDate.getUTCMonth() + 1, 1));
      const daysToMonthEnd = Math.round((nextMonthFirst.getTime() - bizDate.getTime()) / DAY_MS);
      const dayFactor = (weekday === 0 || weekday === 6 ? 1.55 : 1) * (daysToMonthEnd <= 3 ? 1.3 : 1) * (dom <= 3 ? 1.1 : 1) * (0.75 + rnd() * 0.5);
      const dayPayments: { method: PaymentMethod; amountFen: number }[] = [];
      const daySaleIds: number[] = [];
      const dayReturnIds: number[] = [];

      // 1. 早上：到期的回收机检测转良品
      for (const p of pendingRefurb.filter((x) => x.day === day)) {
        const t = at(bizDate, 9, between(20, 50));
        ledger({ docType: "REFURBISH", docNo: out.tradeIns.find((r) => r.id === p.device.tradeInOrderId)!.orderNo as string, storeId: store.id, skuId: p.device.skuId, deviceId: p.device.id, qtyDelta: 0, statusBefore: "RECYCLED", statusAfter: "REFURBISHED", operatorId: manager.id, note: "检测合格转良品", createdAt: t });
        p.device.status = "REFURBISHED";
        p.device.updatedAt = t;
        refurbished.push(p.device);
      }

      // 2. 先规划今天的单（需要哪些货），再按需早上到货
      const orderCount = Math.max(2, Math.round(11 * storeFactor.get(store.id)! * dayFactor));
      type Plan = { time: Date; deviceSku: (typeof deviceSkus)[number] | null; refurb: boolean; accessories: { sku: (typeof accessorySkus)[number]; qty: number }[]; tradeIn: boolean };
      const plans: Plan[] = [];
      for (let i = 0; i < orderCount; i++) {
        const minute = between(10 * 60, 21 * 60 + 40);
        const time = at(bizDate, Math.floor(minute / 60), minute % 60);
        const hasDevice = chance(0.86);
        const refurb = hasDevice && refurbished.length > 0 && chance(0.12);
        const deviceSku = hasDevice && !refurb ? weighted(deviceSkus, deviceWeight) : null;
        const accessories: Plan["accessories"] = [];
        const accCount = hasDevice ? (chance(0.55) ? 1 : 0) + (chance(0.18) ? 1 : 0) : between(1, 2);
        for (let k = 0; k < accCount; k++) {
          const sku = weighted(accessorySkus, accessoryWeight);
          if (!accessories.some((a) => a.sku.id === sku.id)) accessories.push({ sku, qty: hasDevice ? 1 : between(1, 2) });
        }
        if (!hasDevice && accessories.length === 0) continue;
        plans.push({ time, deviceSku, refurb, accessories, tradeIn: Boolean(deviceSku) && chance(0.16) });
      }
      plans.sort((a, b) => a.time.getTime() - b.time.getTime());

      const needDevices = new Map<number, number>();
      for (const p of plans) if (p.deviceSku) needDevices.set(p.deviceSku.id, (needDevices.get(p.deviceSku.id) ?? 0) + 1);
      const needAcc = new Map<number, number>();
      for (const p of plans) for (const a of p.accessories) needAcc.set(a.sku.id, (needAcc.get(a.sku.id) ?? 0) + a.qty);
      const receiptLines: { skuId: number; qty: number; unitCostFen: number; device: boolean }[] = [];
      for (const [skuId, need] of needDevices) {
        const have = inStock.get(skuId)?.length ?? 0;
        if (have < need) receiptLines.push({ skuId, qty: need - have + (chance(0.5) ? between(1, 3) : 0), unitCostFen: skus.find((s) => s.id === skuId)!.costPriceFen, device: true });
      }
      for (const [skuId, need] of needAcc) {
        const have = accessoryBal.get(skuId) ?? 0;
        if (have < need + 5) receiptLines.push({ skuId, qty: between(30, 60), unitCostFen: skus.find((s) => s.id === skuId)!.costPriceFen, device: false });
      }
      if (receiptLines.length > 0) receive(store.id, bizDate, at(bizDate, 9, between(0, 15)), receiptLines);

      // 3. 退货（之前的单，上午处理）
      for (const saleId of scheduledReturns.get(day) ?? []) {
        const sale = saleById.get(saleId)!;
        if (sale.status !== "COMPLETED") continue;
        const items = out.saleItems.filter((i) => i.orderId === sale.id && i.returnedQty < i.qty);
        const item = items.find((i) => i.deviceId) ?? items.find((i) => !serviceSkuIds.has(i.skuId));
        if (!item) continue;
        const t = at(bizDate, between(10, 12), between(0, 59));
        const salePays = out.payments.filter((p) => p.salesOrderId === sale.id && p.amountFen > 0);
        const cashPaid = salePays.filter((p) => p.method !== "TRADE_IN").reduce((s, p) => s + p.amountFen, 0);
        const lineFen = Math.round((item.lineTotalFen * 1) / item.qty);
        const refundFen = Math.min(cashPaid, Math.round((lineFen * sale.totalFen) / sale.subtotalFen));
        const method = salePays.find((p) => p.method !== "TRADE_IN")?.method ?? "CASH";
        const no = docNo("RT", bizDate);
        const retId = ++ids.ret;
        out.returns.push({ id: retId, orderNo: no, storeId: store.id, salesOrderId: sale.id, customerId: sale.customerId, handledById: manager.id, bizDate, refundFen, reason: pick(["质量问题", "客户不想要了", "颜色不喜欢", "七天无理由"]), dailyCloseId: null, createdAt: t });
        out.returnItems.push({ id: ++ids.retItem, returnOrderId: retId, salesItemId: item.id, skuId: item.skuId, deviceId: item.deviceId, qty: 1, refundFen });
        if (refundFen > 0) {
          out.payments.push({ id: ++ids.payment, salesOrderId: null, returnOrderId: retId, method, amountFen: -refundFen, tradeInOrderId: null, reference: null, createdAt: t });
          dayPayments.push({ method, amountFen: -refundFen });
        }
        item.returnedQty += 1;
        if (item.deviceId) {
          const device = out.devices[item.deviceId - 1]!;
          const back: DeviceStatus = device.tradeInOrderId ? "REFURBISHED" : "IN_STOCK";
          ledger({ docType: "RETURN", docNo: no, storeId: store.id, skuId: device.skuId, deviceId: device.id, qtyDelta: 1, statusBefore: "SOLD", statusAfter: back, operatorId: manager.id, createdAt: t });
          device.status = back;
          device.updatedAt = t;
          if (back === "REFURBISHED") refurbished.push(device);
          else inStock.set(device.skuId, [...(inStock.get(device.skuId) ?? []), device]);
        } else {
          const bal = (accessoryBal.get(item.skuId) ?? 0) + 1;
          accessoryBal.set(item.skuId, bal);
          ledger({ docType: "RETURN", docNo: no, storeId: store.id, skuId: item.skuId, qtyDelta: 1, balanceAfter: bal, operatorId: manager.id, createdAt: t });
        }
        dayReturnIds.push(retId);
      }

      // 4. 按时间开单
      for (const plan of plans) {
        const salesperson = weighted(staff, (u) => staffSkill.get(u.id)!);
        const no = docNo("SO", bizDate);
        const saleId = ++ids.sale;
        const items: SaleItemRec[] = [];
        let tradeInId: number | null = null;
        let tradeInFen = 0;

        if (plan.refurb && refurbished.length > 0) {
          const device = refurbished.splice(Math.floor(rnd() * refurbished.length), 1)[0]!;
          const price = Math.round((device.costFen * (1.3 + rnd() * 0.3)) / 1000) * 1000;
          items.push({ id: ++ids.saleItem, orderId: saleId, skuId: device.skuId, deviceId: device.id, qty: 1, unitPriceFen: price, discountFen: 0, lineTotalFen: price, costFen: device.costFen, returnedQty: 0 });
          ledger({ docType: "SALE", docNo: no, storeId: store.id, skuId: device.skuId, deviceId: device.id, qtyDelta: -1, statusBefore: "REFURBISHED", statusAfter: "SOLD", operatorId: salesperson.id, createdAt: plan.time });
          device.status = "SOLD";
          device.updatedAt = plan.time;
        }
        if (plan.deviceSku) {
          const pool = inStock.get(plan.deviceSku.id)!;
          const device = pool.shift()!;
          const price = plan.deviceSku.guidePriceFen;
          items.push({ id: ++ids.saleItem, orderId: saleId, skuId: device.skuId, deviceId: device.id, qty: 1, unitPriceFen: price, discountFen: 0, lineTotalFen: price, costFen: device.costFen, returnedQty: 0 });
          ledger({ docType: "SALE", docNo: no, storeId: store.id, skuId: device.skuId, deviceId: device.id, qtyDelta: -1, statusBefore: "IN_STOCK", statusAfter: "SOLD", operatorId: salesperson.id, createdAt: plan.time });
          device.status = "SOLD";
          device.updatedAt = plan.time;
        }
        for (const a of plan.accessories) {
          const bal = (accessoryBal.get(a.sku.id) ?? 0) - a.qty;
          accessoryBal.set(a.sku.id, bal);
          items.push({ id: ++ids.saleItem, orderId: saleId, skuId: a.sku.id, deviceId: null, qty: a.qty, unitPriceFen: a.sku.guidePriceFen, discountFen: 0, lineTotalFen: a.sku.guidePriceFen * a.qty, costFen: a.sku.costPriceFen * a.qty, returnedQty: 0 });
          ledger({ docType: "SALE", docNo: no, storeId: store.id, skuId: a.sku.id, qtyDelta: -a.qty, balanceAfter: bal, operatorId: salesperson.id, createdAt: plan.time });
        }

        if (items.length === 0) continue; // 规划时的良品被前面的单卖掉了
        // 买新机的约两成加一份服务，保的就是这台新机
        let service: { item: SaleItemRec; months: number; deviceId: number } | null = null;
        const newDeviceItem = plan.deviceSku ? items[items.length - 1 - plan.accessories.length] : undefined;
        if (newDeviceItem?.deviceId && serviceSkus.length > 0 && chance(0.2)) {
          const sv = weighted(serviceSkus, (x) => SERVICE_WEIGHT[x.name] ?? 1);
          const item: SaleItemRec = { id: ++ids.saleItem, orderId: saleId, skuId: sv.id, deviceId: null, qty: 1, unitPriceFen: sv.guidePriceFen, discountFen: 0, lineTotalFen: sv.guidePriceFen, costFen: sv.costPriceFen, returnedQty: 0 };
          items.push(item);
          service = { item, months: sv.serviceMonths!, deviceId: newDeviceItem.deviceId };
        }
        const subtotalFen = items.reduce((s, i) => s + i.lineTotalFen, 0);
        const discountFen = plan.deviceSku && chance(0.3) ? Math.min(between(5, 30) * 1000, Math.floor(subtotalFen * 0.08 / 1000) * 1000) : 0;
        const totalFen = subtotalFen - discountFen;
        const customerId = customerFor(plan.tradeIn || service !== null);

        // 以旧换新：先收旧机（开单前 5 到 15 分钟）
        if (plan.tradeIn && customerId) {
          const old = pick(OLD_PHONES);
          tradeInFen = Math.min(between(old.min, old.max) * 100, Math.floor(totalFen * 0.6));
          tradeInFen = Math.round(tradeInFen / 1000) * 1000;
          if (tradeInFen > 0) {
            const t = new Date(plan.time.getTime() - between(5, 15) * 60000);
            const rcNo = docNo("RC", bizDate);
            tradeInId = ++ids.tradeIn;
            const code = oldPhoneCode();
            const condition = pick(CONDITIONS);
            out.tradeIns.push({ id: tradeInId, orderNo: rcNo, storeId: store.id, customerId, handledById: salesperson.id, deviceCode: code, modelName: old.name, skuId: genericSku.id, condition, appraisedFen: tradeInFen, status: "COMPLETED", note: null, createdAt: t, updatedAt: t });
            const device: DeviceRec = { id: ++ids.device, code, sn: null, imei1: code, imei2: null, skuId: genericSku.id, storeId: store.id, status: "RECYCLED", costFen: tradeInFen, condition, goodsReceiptId: null, tradeInOrderId: tradeInId, createdAt: t, updatedAt: t };
            out.devices.push(device);
            ledger({ docType: "TRADE_IN", docNo: rcNo, storeId: store.id, skuId: genericSku.id, deviceId: device.id, qtyDelta: 1, statusAfter: "RECYCLED", operatorId: salesperson.id, note: old.name, createdAt: t });
            if (condition !== "有损" && chance(0.7)) pendingRefurb.push({ device, day: day + between(2, 6) });
          }
        }

        // 收款：抵扣 + 一到两种方式，合计 = 应收
        const pays: PaymentRec[] = [];
        if (tradeInId) pays.push({ id: ++ids.payment, salesOrderId: saleId, returnOrderId: null, method: "TRADE_IN", amountFen: tradeInFen, tradeInOrderId: tradeInId, reference: out.tradeIns[tradeInId - 1]!.orderNo as string, createdAt: plan.time });
        let rest = totalFen - tradeInFen;
        const primary = weighted(METHOD_WEIGHTS.filter(([m]) => m !== "INSTALLMENT" || rest >= 300000), ([, w]) => w)[0];
        if (rest > 100000 && chance(0.2)) {
          const second: PaymentMethod = primary === "CASH" ? "WECHAT" : "CASH";
          const part = Math.min(rest - 10000, between(2, 15) * 10000);
          pays.push({ id: ++ids.payment, salesOrderId: saleId, returnOrderId: null, method: second, amountFen: part, tradeInOrderId: null, reference: null, createdAt: plan.time });
          rest -= part;
        }
        if (rest > 0) pays.push({ id: ++ids.payment, salesOrderId: saleId, returnOrderId: null, method: primary, amountFen: rest, tradeInOrderId: null, reference: null, createdAt: plan.time });

        const sale: SaleRec = { id: saleId, orderNo: no, storeId: store.id, customerId, salespersonId: salesperson.id, status: "COMPLETED", bizDate, subtotalFen, discountFen, totalFen, tradeInOrderId: tradeInId, dailyCloseId: null, note: null, voidedById: null, voidedAt: null, voidReason: null, createdAt: plan.time, updatedAt: plan.time };
        out.sales.push(sale);
        out.saleItems.push(...items);
        out.payments.push(...pays);
        saleById.set(saleId, sale);
        const entitlement: EntitlementRec | null = service
          ? { id: ++ids.entitlement, customerId: customerId!, storeId: store.id, salesOrderId: saleId, salesOrderItemId: service.item.id, skuId: service.item.skuId, deviceId: service.deviceId, startedOn: bizDate, expiresOn: entitlementExpiresOn(bizDate, service.months), status: "ACTIVE", voidedAt: null, createdAt: plan.time, updatedAt: plan.time }
          : null;
        if (entitlement) out.entitlements.push(entitlement);

        // 少量当天作废（不含以旧换新的单）：库存回来，收款不计入日结
        if (!tradeInId && chance(0.012)) {
          const t = new Date(plan.time.getTime() + between(20, 90) * 60000);
          sale.status = "VOIDED";
          sale.voidedById = manager.id;
          sale.voidedAt = t;
          sale.voidReason = pick(["客户反悔", "开错单", "价格录错"]);
          sale.updatedAt = t;
          if (entitlement) {
            entitlement.status = "VOIDED";
            entitlement.voidedAt = t;
            entitlement.updatedAt = t;
          }
          for (const item of items) {
            if (item.deviceId) {
              const device = out.devices[item.deviceId - 1]!;
              const back: DeviceStatus = device.tradeInOrderId ? "REFURBISHED" : "IN_STOCK";
              ledger({ docType: "SALE_VOID", docNo: no, storeId: store.id, skuId: device.skuId, deviceId: device.id, qtyDelta: 1, statusBefore: "SOLD", statusAfter: back, operatorId: manager.id, note: sale.voidReason, createdAt: t });
              device.status = back;
              device.updatedAt = t;
              if (back === "REFURBISHED") refurbished.push(device);
              else inStock.get(device.skuId)!.push(device);
            } else if (!serviceSkuIds.has(item.skuId)) {
              const bal = (accessoryBal.get(item.skuId) ?? 0) + item.qty;
              accessoryBal.set(item.skuId, bal);
              ledger({ docType: "SALE_VOID", docNo: no, storeId: store.id, skuId: item.skuId, qtyDelta: item.qty, balanceAfter: bal, operatorId: manager.id, note: sale.voidReason, createdAt: t });
            }
          }
          continue;
        }

        dayPayments.push(...pays.map((p) => ({ method: p.method, amountFen: p.amountFen })));
        daySaleIds.push(saleId);
        // 少量几天后退货
        if (chance(0.015)) {
          const rd = day + between(1, 5);
          if (rd <= -1) scheduledReturns.set(rd, [...(scheduledReturns.get(rd) ?? []), saleId]);
        }
      }

      // 5. 晚上日结：系统数 = 当天收款汇总；偶尔现金长短款
      const closeId = ++ids.close;
      const t = at(bizDate, 22, between(0, 30));
      const diffCash = chance(0.06) ? (chance(0.5) ? 1 : -1) * between(1, 50) * 100 : 0;
      out.closes.push({ id: closeId, closeNo: docNo("DC", bizDate), storeId: store.id, bizDate, status: "CONFIRMED", confirmedById: manager.id, confirmedAt: t, note: diffCash ? `现金${diffCash > 0 ? "长款" : "短款"} ${Math.abs(diffCash) / 100} 元，已登记` : null, createdAt: t, updatedAt: t });
      for (const method of ["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER", "TRADE_IN"] as PaymentMethod[]) {
        const systemFen = dayPayments.filter((p) => p.method === method).reduce((s, p) => s + p.amountFen, 0);
        const actualFen = method === "CASH" ? systemFen + diffCash : systemFen;
        out.closeLines.push({ id: ++ids.closeLine, dailyCloseId: closeId, method, systemFen, actualFen, diffFen: actualFen - systemFen });
      }
      for (const id of daySaleIds) saleById.get(id)!.dailyCloseId = closeId;
      for (const id of dayReturnIds) out.returns[id - 1]!.dailyCloseId = closeId;
    }

    // 收尾：昨晚补一次货，保证演示时每家店常卖的机型都有库存、配件不缺
    const yesterday = bizDateOf(-1);
    const topUp: { skuId: number; qty: number; unitCostFen: number; device: boolean }[] = [];
    const popular = [...deviceSkus].sort((a, b) => deviceWeight(b) - deviceWeight(a)).slice(0, 30);
    for (const s of popular) {
      const have = inStock.get(s.id)?.length ?? 0;
      if (have < 2) topUp.push({ skuId: s.id, qty: 2 - have + between(0, 2), unitCostFen: s.costPriceFen, device: true });
    }
    for (const s of accessorySkus) {
      const have = accessoryBal.get(s.id) ?? 0;
      if (have < 15) topUp.push({ skuId: s.id, qty: 30 - have, unitCostFen: s.costPriceFen, device: false });
    }
    if (topUp.length) receive(store.id, yesterday, at(yesterday, 21, 50), topUp);

    // 到货：一张采购单 + 一张入库单；大件一台一条机器和流水，小件一条流水
    function receive(storeId: number, bizDate: Date, t: Date, lines: { skuId: number; qty: number; unitCostFen: number; device: boolean }[]) {
      const poId = ++ids.po;
      const poNo = docNo("PO", bizDate);
      const submitted = new Date(t.getTime() - between(1, 3) * DAY_MS);
      out.purchaseOrders.push({ id: poId, orderNo: poNo, storeId, status: "RECEIVED", supplierName: pick(["华为省代", "苹果授权分销", "小米生态分销", "通讯配件批发"]), note: null, createdById: hq!.id, submittedAt: submitted, receivedAt: t, createdAt: submitted, updatedAt: t });
      const riId = ++ids.receipt;
      const riNo = docNo("RI", bizDate);
      out.receipts.push({ id: riId, receiptNo: riNo, purchaseOrderId: poId, storeId, receivedById: manager.id, note: null, createdAt: t });
      for (const line of lines) {
        out.purchaseItems.push({ id: ++ids.poItem, orderId: poId, skuId: line.skuId, qty: line.qty, unitCostFen: line.unitCostFen, receivedQty: line.qty });
        out.receiptItems.push({ id: ++ids.receiptItem, receiptId: riId, skuId: line.skuId, qty: line.qty, unitCostFen: line.unitCostFen });
        if (line.device) {
          const apple = skus.find((s) => s.id === line.skuId)!.model.brand.name === "苹果";
          for (let i = 0; i < line.qty; i++) {
            const codes = newDeviceCodes(apple);
            const device: DeviceRec = { id: ++ids.device, ...codes, skuId: line.skuId, storeId, status: "IN_STOCK", costFen: line.unitCostFen, condition: null, goodsReceiptId: riId, tradeInOrderId: null, createdAt: t, updatedAt: t };
            out.devices.push(device);
            inStock.set(line.skuId, [...(inStock.get(line.skuId) ?? []), device]);
            ledger({ docType: "PURCHASE_RECEIPT", docNo: riNo, storeId, skuId: line.skuId, deviceId: device.id, qtyDelta: 1, statusAfter: "IN_STOCK", operatorId: manager.id, createdAt: t });
          }
        } else {
          const bal = (accessoryBal.get(line.skuId) ?? 0) + line.qty;
          accessoryBal.set(line.skuId, bal);
          ledger({ docType: "PURCHASE_RECEIPT", docNo: riNo, storeId, skuId: line.skuId, qtyDelta: line.qty, balanceAfter: bal, operatorId: manager.id, createdAt: t });
        }
      }
    }

    // 这家店的配件余额
    for (const [skuId, qty] of accessoryBal) accessoryRows.push({ storeId: store.id, skuId, qty });
    customerPool = customerPool.slice(-400);
  }

  buildReminders();

  // KPI 目标：已过完的月份 = 实际 × 0.9～1.15（完成率有高有低），当月 = 上月日均 × 当月天数 × 1.05
  buildKpis(stores.map((s) => s.id));

  await write();
  await verify();
  await prisma.$disconnect();
}

const accessoryRows: { storeId: number; skuId: number; qty: number }[] = [];

/** 到期提醒：每档在进入区间那天（剩 30 天、剩 7 天，不早于开单日）早上 9 点生成；两天前的有六成门店已联系 */
function buildReminders() {
  const yesterday = bizDateOf(-1);
  const salesById = new Map(out.sales.map((x) => [x.id, x]));
  const NOTES = ["已续保", "客户说再考虑", "电话没接通，已发短信", "不需要续保", "约了周末来店"];
  for (const e of out.entitlements) {
    if (e.status !== "ACTIVE") continue;
    const salespersonId = salesById.get(e.salesOrderId)!.salespersonId;
    for (const [stage, days] of [["T30", 30], ["T7", 7]] as const) {
      const windowEnd = stage === "T30" ? 8 : 0; // 这一档区间的最后一天（剩几天）
      const enter = new Date(Math.max(e.expiresOn.getTime() - days * DAY_MS, e.startedOn.getTime()));
      if (enter > yesterday || daysUntil(e.expiresOn, enter) < windowEnd) continue; // 还没到这一档，或者开单时就已经过了这一档
      const createdAt = at(enter, 9, 0);
      const contacted = daysUntil(yesterday, enter) >= 2 && chance(0.6);
      const contactedAt = contacted ? at(new Date(enter.getTime() + between(0, 1) * DAY_MS), between(10, 20), between(0, 59)) : null;
      out.reminders.push({ id: ++ids.reminder, entitlementId: e.id, stage, createdAt, contactedAt, contactedById: contacted ? salespersonId : null, note: contacted ? pick(NOTES) : null });
    }
  }
}

function buildKpis(storeIds: number[]) {
  const monthKey = (d: Date) => d.toISOString().slice(0, 7);
  const today = bizDateOf(0);
  const months = new Set<string>(out.sales.map((s) => monthKey(s.bizDate)));
  months.add(monthKey(today));
  const completed = out.sales.filter((s) => s.status === "COMPLETED");
  const itemsByOrder = new Map<number, SaleItemRec[]>();
  for (const i of out.saleItems) itemsByOrder.set(i.orderId, [...(itemsByOrder.get(i.orderId) ?? []), i]);
  for (const storeId of storeIds) {
    const stats = new Map<string, { sales: number; profit: number; devices: number; tradeIns: number; days: Set<string> }>();
    for (const s of completed.filter((x) => x.storeId === storeId)) {
      const k = monthKey(s.bizDate);
      const st = stats.get(k) ?? { sales: 0, profit: 0, devices: 0, tradeIns: 0, days: new Set() };
      const items = itemsByOrder.get(s.id) ?? [];
      st.sales += s.totalFen;
      st.profit += items.reduce((a, i) => a + i.lineTotalFen - i.costFen, 0) - s.discountFen;
      st.devices += items.filter((i) => i.deviceId).length;
      st.tradeIns += s.tradeInOrderId ? 1 : 0;
      st.days.add(s.bizDate.toISOString().slice(0, 10));
      stats.set(k, st);
    }
    const sorted = [...months].sort();
    for (const k of sorted) {
      const [y, m] = k.split("-").map(Number) as [number, number];
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const st = stats.get(k);
      const isCurrent = k === monthKey(today);
      const ref = isCurrent ? stats.get(sorted[sorted.indexOf(k) - 1] ?? "") ?? st : st;
      if (!ref) continue;
      // 完成率有高有低：有的店超额、有的店落后
      const scale = isCurrent || ref.days.size < daysInMonth - 2 ? (daysInMonth / Math.max(ref.days.size, 1)) * (0.85 + rnd() * 0.3) : 0.9 + rnd() * 0.25;
      const round = (n: number, to: number) => Math.max(to, Math.round(n / to) * to);
      out.kpis.push({
        id: ++ids.kpi,
        storeId,
        year: y,
        month: m,
        salesTargetFen: round(ref.sales * scale, 1000000),
        profitTargetFen: round(ref.profit * scale, 100000),
        deviceQtyTarget: round(ref.devices * scale, 5),
        tradeInQtyTarget: round(ref.tradeIns * scale, 1),
      });
    }
  }
}

async function insert<T extends Row>(label: string, rows: T[], fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 2000) await fn(rows.slice(i, i + 2000));
  console.log(`  ${label}：${rows.length}`);
}

async function write() {
  console.log("写入数据库：");
  await insert("客户", out.customers, (c) => prisma.customer.createMany({ data: c as never }));
  await insert("采购单", out.purchaseOrders, (c) => prisma.purchaseOrder.createMany({ data: c as never }));
  await insert("采购明细", out.purchaseItems, (c) => prisma.purchaseOrderItem.createMany({ data: c as never }));
  await insert("入库单", out.receipts, (c) => prisma.goodsReceipt.createMany({ data: c as never }));
  await insert("入库明细", out.receiptItems, (c) => prisma.goodsReceiptItem.createMany({ data: c as never }));
  await insert("回收单", out.tradeIns, (c) => prisma.tradeInOrder.createMany({ data: c as never }));
  await insert("机器", out.devices as unknown as Row[], (c) => prisma.device.createMany({ data: c as never }));
  await insert("日结", out.closes, (c) => prisma.dailyClose.createMany({ data: c as never }));
  await insert("日结明细", out.closeLines, (c) => prisma.dailyCloseLine.createMany({ data: c as never }));
  await insert("销售单", out.sales as unknown as Row[], (c) => prisma.salesOrder.createMany({ data: c as never }));
  await insert("销售明细", out.saleItems as unknown as Row[], (c) => prisma.salesOrderItem.createMany({ data: c as never }));
  await insert("退货单", out.returns, (c) => prisma.returnOrder.createMany({ data: c as never }));
  await insert("退货明细", out.returnItems, (c) => prisma.returnOrderItem.createMany({ data: c as never }));
  await insert("收款", out.payments as unknown as Row[], (c) => prisma.payment.createMany({ data: c as never }));
  await insert("服务权益", out.entitlements as unknown as Row[], (c) => prisma.serviceEntitlement.createMany({ data: c as never }));
  await insert("到期提醒", out.reminders, (c) => prisma.entitlementReminder.createMany({ data: c as never }));
  await insert("配件库存", accessoryRows, (c) => prisma.accessoryStock.createMany({ data: c as never }));
  await insert("库存流水", out.ledgers, (c) => prisma.stockLedger.createMany({ data: c as never }));
  await insert("KPI 目标", out.kpis, (c) => prisma.kpiTarget.createMany({ data: c as never }));
  for (const [key, value] of docCounters) {
    await prisma.docCounter.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  // 自己指定了 id，自增序列要跟上，后面正常开单才不会撞号
  const tables = ["customers", "purchase_orders", "purchase_order_items", "goods_receipts", "goods_receipt_items", "trade_in_orders", "devices", "daily_closes", "daily_close_lines", "sales_orders", "sales_order_items", "return_orders", "return_order_items", "payments", "accessory_stocks", "stock_ledgers", "kpi_targets", "service_entitlements", "entitlement_reminders"];
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM "${t}"), 0), 1), (SELECT COUNT(*) > 0 FROM "${t}"))`);
  }
}

/** 自检：对账 SQL 抽到 integrity-checks.ts，上线后 pnpm db:check 也用同一套 */
async function verify() {
  const result = await runIntegrityChecks(prisma);
  const sales = out.sales.filter((s) => s.status === "COMPLETED");
  console.log(
    `模拟数据完成：${sales.length} 张有效销售单（作废 ${out.sales.length - sales.length}）、${out.tradeIns.length} 张回收单、${out.returns.length} 张退货单、${out.devices.length} 台机器、${out.closes.length} 次日结、${out.entitlements.length} 份碎屏险和延保。`,
  );
  console.log(`自检：${describeIntegrity(result)}`);
  if (!integrityOk(result)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
