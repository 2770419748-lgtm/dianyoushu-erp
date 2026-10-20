import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import type { DeviceStatus, LedgerDocType, PaymentMethod } from "../src/generated/prisma/enums";
import { formatDate } from "../src/lib/format";
import { describeIntegrity, integrityOk, runIntegrityChecks } from "./integrity-checks";
import { daysUntil, entitlementPeriod } from "../src/lib/entitlement";
import { payerOptions, repairChargeFen, type FaultCategoryKey, type RepairPayerKey } from "../src/lib/repair";
import { monthRange, reconcileStatement, type CarrierBizTypeKey, type CarrierKey, type StatementLine } from "../src/lib/carrier";
import { lineBaseFen, subsidyFenOf, type SubsidyStatusKey } from "../src/lib/subsidy";
import { buildInvoiceLines, simulateInvoiceNumber, type InvoiceKindKey, type InvoiceStatusKey, type InvoiceTitleTypeKey } from "../src/lib/invoice";

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
// 售后：故障类型的比例、配件费 / 工时费区间（元）、描述
const FAULT_WEIGHTS: [FaultCategoryKey, number][] = [["SCREEN", 35], ["BATTERY", 25], ["SOFTWARE", 12], ["BOARD", 8], ["WATER", 8], ["CAMERA", 7], ["OTHER", 5]];
const FAULT_PRICE: Record<FaultCategoryKey, [number, number, number, number]> = {
  SCREEN: [600, 1500, 50, 100],
  BATTERY: [150, 300, 30, 50],
  BOARD: [400, 1200, 100, 200],
  CAMERA: [300, 800, 50, 80],
  WATER: [200, 600, 100, 150],
  SOFTWARE: [0, 0, 50, 100],
  OTHER: [100, 300, 50, 80],
};
const FAULT_TEXT: Record<FaultCategoryKey, string[]> = {
  SCREEN: ["摔了一下，外屏碎了，触摸正常", "屏幕有一条绿线", "屏幕碎裂，局部触摸失灵"],
  BATTERY: ["电池不耐用，半天就没电", "电池鼓包，后盖翘起", "充电很慢、发烫"],
  BOARD: ["突然黑屏开不了机", "反复重启", "信号时有时无"],
  CAMERA: ["后摄拍照模糊", "前摄打不开", "相机对不上焦"],
  WATER: ["掉水里了，捞起来开不了机", "进水后喇叭没声音"],
  SOFTWARE: ["系统卡顿，想重装", "忘了锁屏密码", "升级后耗电很快"],
  OTHER: ["按键失灵", "听筒有杂音", "充电口接触不良"],
};
const REPAIR_METHODS: [PaymentMethod, number][] = [["WECHAT", 50], ["ALIPAY", 25], ["CASH", 20], ["CARD", 5]];
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
const ids = { customer: 0, po: 0, poItem: 0, receipt: 0, receiptItem: 0, tradeIn: 0, device: 0, close: 0, closeLine: 0, sale: 0, saleItem: 0, payment: 0, ret: 0, retItem: 0, ledger: 0, kpi: 0, entitlement: 0, reminder: 0, repair: 0 };
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
  repairs: [] as RepairRec[],
  wecomFollows: [] as Row[],
  wecomTags: [] as Row[],
  wecomCustomerTags: [] as Row[],
  subsidyPolicies: [] as Row[],
  subsidyClaims: [] as SubsidyRec[],
  invoices: [] as InvoiceRec[],
  invoiceLines: [] as Row[],
  approvalRules: [] as Row[],
  approvals: [] as Row[],
};
// 审批规则（口径第 17 节，演示打开四条）：店员让利超过 5% 要店长批、退款 3000 元起要店长批、调拨货值 2 万起和盘亏 500 元起要总部批
const DEMO_APPROVAL_RULES = [
  { kind: "SALE_DISCOUNT", enabled: true, thresholdFen: null, thresholdBp: 500, approverRole: "STORE_MANAGER" },
  { kind: "SALE_BELOW_COST", enabled: false, thresholdFen: null, thresholdBp: null, approverRole: "STORE_MANAGER" },
  { kind: "RETURN_REFUND", enabled: true, thresholdFen: 300000, thresholdBp: null, approverRole: "STORE_MANAGER" },
  { kind: "SALE_VOID", enabled: false, thresholdFen: 0, thresholdBp: null, approverRole: "HQ" },
  { kind: "TRANSFER", enabled: true, thresholdFen: 2000000, thresholdBp: null, approverRole: "HQ" },
  { kind: "STOCKTAKE_LOSS", enabled: true, thresholdFen: 50000, thresholdBp: null, approverRole: "HQ" },
];
const fmtYuan = (fen: number) => (fen / 100).toFixed(2);
/** 一张审批单（演示数据）：已通过的挂着做出来的销售单，待审批的带着批了就能执行的开单、调拨内容 */
function pushApproval(row: { action: "SALE" | "TRANSFER"; storeId: number; requestedById: number; approverRole: "STORE_MANAGER" | "HQ"; status: "PENDING" | "EXECUTED" | "REJECTED"; summary: string; reasons: { kind: string; text: string }[]; amountFen: number; payload: unknown; createdAt: Date; decidedById?: number; decidedAt?: Date; decisionNote?: string; resultId?: number; resultNo?: string }) {
  out.approvals.push({
    id: out.approvals.length + 1,
    requestNo: docNo("SP", new Date(`${row.createdAt.toISOString().slice(0, 10)}T00:00:00.000Z`)),
    action: row.action,
    storeId: row.storeId,
    requestedById: row.requestedById,
    approverRole: row.approverRole,
    status: row.status,
    summary: row.summary,
    reasons: row.reasons,
    amountFen: row.amountFen,
    note: null,
    payload: row.payload,
    dedupeKey: null,
    decidedById: row.decidedById ?? null,
    decidedAt: row.decidedAt ?? null,
    decisionNote: row.decisionNote ?? null,
    resultId: row.resultId ?? null,
    resultNo: row.resultNo ?? null,
    error: null,
    createdAt: row.createdAt,
    updatedAt: row.decidedAt ?? row.createdAt,
  });
}
interface InvoiceRec {
  id: number;
  requestNo: string;
  storeId: number;
  salesOrderId: number;
  customerId: number | null;
  kind: InvoiceKindKey;
  titleType: InvoiceTitleTypeKey;
  titleName: string;
  buyerTaxNo: string | null;
  buyerAddressPhone: string | null;
  buyerBankAccount: string | null;
  receiver: string | null;
  amountFen: number;
  taxFen: number;
  status: InvoiceStatusKey;
  requestedById: number;
  invoiceNumber: string | null;
  issueSource: "SIMULATED" | null;
  issuedAt: Date | null;
  issuedById: number | null;
  sellerSnapshot: unknown;
  deliveredAt: Date | null;
  redNumber: string | null;
  redAt: Date | null;
  redById: number | null;
  redReason: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
// 公司开票信息（演示）：开具时存一份快照到发票上
const DEMO_SELLER = { name: "店有数通讯连锁有限公司（演示）", taxNo: "91440300MA5DEMO001", addressPhone: "深圳市南山区科技园演示路 1 号 0755-12345678", bankAccount: "招商银行深圳科技园支行 755900000000001" };
const COMPANY_TITLES = ["深圳市云帆科技有限公司", "广州启明贸易有限公司", "东莞市恒信电子有限公司", "佛山市安达物流有限公司", "珠海星海文化传媒有限公司"];
let invoiceNumberSeq = 800000000000;
const skuNames = new Map<number, string>();
const serviceSkuIdSet = new Set<number>();
let hqId = 0;
const invoiceBySale = new Map<number, InvoiceRec>();
interface SubsidyRec {
  id: number;
  claimNo: string;
  storeId: number;
  salesOrderId: number;
  salesOrderItemId: number;
  customerId: number;
  deviceId: number;
  policyId: number;
  categoryId: number;
  bizDate: Date;
  basePriceFen: number;
  subsidyFen: number;
  qualificationCode: string;
  invoiceNo: string | null;
  status: SubsidyStatusKey;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  rejectReason: string | null;
  settledAt: Date | null;
  settledFen: number | null;
  cancelledAt: Date | null;
  returnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface RepairRec {
  id: number;
  orderNo: string;
  storeId: number;
  customerId: number;
  receivedById: number;
  deviceId: number | null;
  deviceCode: string;
  modelName: string;
  salesOrderId: number | null;
  purchasedOn: Date | null;
  faultCategory: FaultCategoryKey;
  faultDescription: string;
  appearance: string | null;
  status: "RECEIVED" | "QUOTED" | "REPAIRING" | "READY" | "CLOSED" | "VOIDED";
  partsFen: number | null;
  laborFen: number | null;
  costFen: number | null;
  payer: RepairPayerKey | null;
  entitlementId: number | null;
  chargeFen: number;
  outcome: "REPAIRED" | "NOT_REPAIRED" | null;
  repairNote: string | null;
  quotedAt: Date | null;
  approvedAt: Date | null;
  readyAt: Date | null;
  closedAt: Date | null;
  closedById: number | null;
  bizDate: Date | null;
  dailyCloseId: number | null;
  voidedAt?: Date | null;
  voidedById?: number | null;
  voidReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
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
  status: "ACTIVE" | "VOIDED" | "CLAIMED";
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
  repairOrderId?: number | null;
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
  // 国补政策（口径第 15 节）：手机、平板，成交价的 15%，单件最多 500 元，6000 元以内；演示期间所在年份整年有效
  const policyByCategory = new Map<number, { id: number; rateBp: number; capFen: number; priceCapFen: number; startsOn: Date; endsOn: Date }>();
  for (const name of ["手机", "平板"]) {
    const categoryId = deviceSkus.find((x) => x.model.category.name === name)?.model.categoryId;
    if (!categoryId) continue;
    const policy = { id: out.subsidyPolicies.length + 1, rateBp: 1500, capFen: 50000, priceCapFen: 600000, startsOn: new Date(Date.UTC(bizDateOf(-DAYS).getUTCFullYear(), 0, 1)), endsOn: new Date(Date.UTC(bizDateOf(0).getUTCFullYear(), 11, 31)) };
    policyByCategory.set(categoryId, policy);
    out.subsidyPolicies.push({ ...policy, categoryId, isActive: true, note: "数码产品购新补贴（演示）", createdAt: at(policy.startsOn, 9, 0), updatedAt: at(policy.startsOn, 9, 0) });
  }
  const subsidyUsed = new Map<number, Set<number>>(); // 客户 → 用过国补的品类（每人每类一台）
  for (const x of skus) skuNames.set(x.id, x.name);
  for (const x of skus) if (x.isService) serviceSkuIdSet.add(x.id);
  hqId = hq.id;
  let subsidyCodeSeq = 0;
  const accessorySkus = skus.filter((s) => s.model.category.kind === "ACCESSORY" && !s.isService);
  // 服务类商品（碎屏险、延保）：买新机的约两成加一份，不进库存，单上必须有客户
  const serviceSkus = skus.filter((s) => s.isService && s.serviceMonths);
  const serviceSkuIds = new Set(serviceSkus.map((s) => s.id));
  const SERVICE_KIND_BY_SKU = new Map(serviceSkus.map((s) => [s.id, (s.serviceKind ?? "OTHER") as "SCREEN_INSURANCE" | "EXTENDED_WARRANTY" | "OTHER"]));
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
    // 售后（口径第 13 节）：卖出去满一周、没排退货的机器才可能拿回来修；取机那天收款进当天日结
    const soldDevices: { deviceId: number; saleId: number; bizDate: Date; customerId: number | null }[] = [];
    const returnScheduled = new Set<number>();
    const repairPickups = new Map<number, RepairRec[]>(); // 第几天 → 那天来取机的维修单
    const openRepairCodes = new Set<string>();

    // 去年的老客户（口径第 12、13 节）：13～14 个月前在本店买机器、加了 1 年延保。延保接在保修后面，现在正在保障期，
    // 这些机器拿来修（非人为故障）就是延保付。老单只有采购到货、开单、收款，不挂日结（那么早的日结不在演示数据里）。
    const oldSaleIds = new Set<number>();
    const extendedSku = serviceSkus.find((x) => SERVICE_KIND_BY_SKU.get(x.id) === "EXTENDED_WARRANTY");
    if (extendedSku) {
      const popularOld = [...deviceSkus].sort((a, b) => deviceWeight(b) - deviceWeight(a)).slice(0, 20);
      const oldCloses = new Map<string, { closeId: number; wechatFen: number; saleIds: number[]; bizDate: Date }>(); // 那天的日结（同一天两张老单合一张）
      for (let k = 0; k < 4; k++) {
        const oldDate = bizDateOf(-between(380, 420));
        const sku = pick(popularOld);
        receive(store.id, oldDate, at(oldDate, 10, between(0, 30)), [{ skuId: sku.id, qty: 1, unitCostFen: sku.costPriceFen, device: true }]);
        const device = inStock.get(sku.id)!.pop()!;
        const t = at(oldDate, between(11, 19), between(0, 59));
        const saleId = ++ids.sale;
        const no = docNo("SO", oldDate);
        const salesperson = pick(staff);
        // 老客户单独建档，建档时间早于开单（不从后面的客户池里借）
        const customerId = ++ids.customer;
        out.customers.push({ id: customerId, name: pick(SURNAMES) + pick(GIVEN) + (chance(0.4) ? pick(GIVEN) : ""), phone: newPhone(), note: null, createdAt: new Date(t.getTime() - between(5, 20) * 60000) });
        const deviceItem: SaleItemRec = { id: ++ids.saleItem, orderId: saleId, skuId: sku.id, deviceId: device.id, qty: 1, unitPriceFen: sku.guidePriceFen, discountFen: 0, lineTotalFen: sku.guidePriceFen, costFen: device.costFen, returnedQty: 0 };
        const serviceItem: SaleItemRec = { id: ++ids.saleItem, orderId: saleId, skuId: extendedSku.id, deviceId: null, qty: 1, unitPriceFen: extendedSku.guidePriceFen, discountFen: 0, lineTotalFen: extendedSku.guidePriceFen, costFen: extendedSku.costPriceFen, returnedQty: 0 };
        const totalFen = deviceItem.lineTotalFen + serviceItem.lineTotalFen;
        ledger({ docType: "SALE", docNo: no, storeId: store.id, skuId: sku.id, deviceId: device.id, qtyDelta: -1, statusBefore: "IN_STOCK", statusAfter: "SOLD", operatorId: salesperson.id, createdAt: t });
        device.status = "SOLD";
        device.updatedAt = t;
        out.sales.push({ id: saleId, orderNo: no, storeId: store.id, customerId, salespersonId: salesperson.id, status: "COMPLETED", bizDate: oldDate, subtotalFen: totalFen, discountFen: 0, totalFen, tradeInOrderId: null, dailyCloseId: null, note: null, voidedById: null, voidedAt: null, voidReason: null, createdAt: t, updatedAt: t });
        out.saleItems.push(deviceItem, serviceItem);
        out.payments.push({ id: ++ids.payment, salesOrderId: saleId, returnOrderId: null, method: "WECHAT", amountFen: totalFen, tradeInOrderId: null, reference: null, createdAt: t });
        out.entitlements.push({ id: ++ids.entitlement, customerId, storeId: store.id, salesOrderId: saleId, salesOrderItemId: serviceItem.id, skuId: extendedSku.id, deviceId: device.id, ...entitlementPeriod("EXTENDED_WARRANTY", oldDate, extendedSku.serviceMonths!), status: "ACTIVE", voidedAt: null, createdAt: t, updatedAt: t });
        soldDevices.push({ deviceId: device.id, saleId, bizDate: oldDate, customerId });
        oldSaleIds.add(saleId);
        const dayKey = oldDate.toISOString().slice(0, 10);
        const close = oldCloses.get(dayKey) ?? { closeId: ++ids.close, wechatFen: 0, saleIds: [], bizDate: oldDate };
        close.wechatFen += totalFen;
        close.saleIds.push(saleId);
        oldCloses.set(dayKey, close);
      }
      // 老单那几天的日结：店长当晚确认，系统数 = 当天老单的微信收款（演示数据别的日子从 92 天前开始）
      for (const c of oldCloses.values()) {
        const t = at(c.bizDate, 22, between(0, 30));
        out.closes.push({ id: c.closeId, closeNo: docNo("DC", c.bizDate), storeId: store.id, bizDate: c.bizDate, status: "CONFIRMED", confirmedById: manager.id, confirmedAt: t, note: null, createdAt: t, updatedAt: t });
        for (const method of ["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER", "TRADE_IN", "SUBSIDY"] as PaymentMethod[]) {
          const fen = method === "WECHAT" ? c.wechatFen : 0;
          out.closeLines.push({ id: ++ids.closeLine, dailyCloseId: c.closeId, method, systemFen: fen, actualFen: fen, diffFen: 0 });
        }
        for (const id of c.saleIds) out.sales.find((x) => x.id === id)!.dailyCloseId = c.closeId;
      }
    }

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
      const dayRepairs: RepairRec[] = [];

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
        // 退的机器买了碎屏险、延保的，服务一起退（退货页也是默认一起勾），演示数据里不出现“机器退了、服务还挂在它上面”
        const svc = item.deviceId ? out.entitlements.find((e) => e.salesOrderId === sale.id && e.deviceId === item.deviceId && e.status === "ACTIVE") : undefined;
        const svcItem = svc ? items.find((i) => i.id === svc.salesOrderItemId) : undefined;
        const t = at(bizDate, between(10, 12), between(0, 59));
        const salePays = out.payments.filter((p) => p.salesOrderId === sale.id && p.amountFen > 0);
        const cashPaid = salePays.filter((p) => p.method !== "TRADE_IN" && p.method !== "SUBSIDY").reduce((s, p) => s + p.amountFen, 0);
        const lineFen = Math.round((item.lineTotalFen * 1) / item.qty) + (svcItem ? svcItem.lineTotalFen : 0);
        const subsidyClaim = out.subsidyClaims.find((c) => c.salesOrderItemId === item.id);
        const refundFen = Math.min(cashPaid, Math.max(0, Math.round((lineFen * sale.totalFen) / sale.subtotalFen) - (subsidyClaim?.subsidyFen ?? 0)));
        if (subsidyClaim) cancelClaim(subsidyClaim, t, day);
        const invoice = invoiceBySale.get(sale.id);
        if (invoice) invoiceAfterReturn(invoice, t, day);
        const method = salePays.find((p) => p.method !== "TRADE_IN" && p.method !== "SUBSIDY")?.method ?? "CASH";
        const no = docNo("RT", bizDate);
        const retId = ++ids.ret;
        out.returns.push({ id: retId, orderNo: no, storeId: store.id, salesOrderId: sale.id, customerId: sale.customerId, handledById: manager.id, bizDate, refundFen, reason: pick(["质量问题", "客户不想要了", "颜色不喜欢", "七天无理由"]), dailyCloseId: null, createdAt: t });
        const svcRefund = svcItem ? Math.round((refundFen * svcItem.lineTotalFen) / lineFen) : 0;
        out.returnItems.push({ id: ++ids.retItem, returnOrderId: retId, salesItemId: item.id, skuId: item.skuId, deviceId: item.deviceId, qty: 1, refundFen: refundFen - svcRefund });
        if (svcItem && svc) {
          out.returnItems.push({ id: ++ids.retItem, returnOrderId: retId, salesItemId: svcItem.id, skuId: svcItem.skuId, deviceId: null, qty: 1, refundFen: svcRefund });
          svcItem.returnedQty += 1;
          svc.status = "VOIDED";
          svc.voidedAt = t;
          svc.updatedAt = t;
        }
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
        const wantSubsidy = !!newDeviceItem?.deviceId && !!plan.deviceSku && policyByCategory.has(plan.deviceSku.model.categoryId) && chance(0.3);
        const customerId = customerFor(plan.tradeIn || service !== null || wantSubsidy);

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
        // 国补：这台新机按分摊整单优惠后的成交价算，6000 元以内补 15%、最多 500 元；客户这一类用过就不补
        let claim: SubsidyRec | null = null;
        let lateReturnDay: number | null = null; // 到账之后才退货的（演示“需退回”“已退回”）
        if (wantSubsidy && customerId && newDeviceItem?.deviceId && plan.deviceSku) {
          const categoryId = plan.deviceSku.model.categoryId;
          const policy = policyByCategory.get(categoryId)!;
          const baseFen = lineBaseFen(newDeviceItem.lineTotalFen, subtotalFen, totalFen);
          if (baseFen <= policy.priceCapFen && !subsidyUsed.get(customerId)?.has(categoryId) && bizDate >= policy.startsOn) {
            const fen = subsidyFenOf(baseFen, policy);
            const seq = ++subsidyCodeSeq;
            const code = `Q${ymd(bizDate)}${String(seq).padStart(5, "0")}${(seq % 9) + 1}`;
            claim = { id: out.subsidyClaims.length + 1, claimNo: docNo("GB", bizDate), storeId: store.id, salesOrderId: saleId, salesOrderItemId: newDeviceItem.id, customerId, deviceId: newDeviceItem.deviceId, policyId: policy.id, categoryId, bizDate, basePriceFen: baseFen, subsidyFen: fen, qualificationCode: code, invoiceNo: null, status: "PENDING", submittedAt: null, reviewedAt: null, rejectReason: null, settledAt: null, settledFen: null, cancelledAt: null, returnedAt: null, createdAt: plan.time, updatedAt: plan.time };
            subsidyUsed.set(customerId, new Set([...(subsidyUsed.get(customerId) ?? []), categoryId]));
            pays.push({ id: ++ids.payment, salesOrderId: saleId, returnOrderId: null, method: "SUBSIDY", amountFen: fen, tradeInOrderId: null, reference: code, createdAt: plan.time });
            advanceClaim(claim, -day);
            // 少数到账之后才退货：退货排在到账后两三天，国补单变需退回（早一点的总部已经退回平台）
            if (claim.status === "SETTLED" && claim.settledAt && chance(0.012)) {
              const rd = day + Math.ceil((claim.settledAt.getTime() - plan.time.getTime()) / DAY_MS) + between(2, 4);
              if (rd <= -1) lateReturnDay = rd;
            }
            out.subsidyClaims.push(claim);
          }
        }
        let rest = totalFen - tradeInFen - (claim?.subsidyFen ?? 0);
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
          ? { id: ++ids.entitlement, customerId: customerId!, storeId: store.id, salesOrderId: saleId, salesOrderItemId: service.item.id, skuId: service.item.skuId, deviceId: service.deviceId, ...entitlementPeriod(SERVICE_KIND_BY_SKU.get(service.item.skuId)!, bizDate, service.months), status: "ACTIVE", voidedAt: null, createdAt: plan.time, updatedAt: plan.time }
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
          if (claim) cancelClaim(claim, t);
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
        if (customerId && (claim || chance(0.2))) makeInvoice(sale, items, claim, salesperson.id, day);
        if (salesperson.role === "STAFF" && discountFen > 0 && discountFen * 10000 >= subtotalFen * 500) {
          const asked = new Date(plan.time.getTime() - between(3, 12) * 60000);
          pushApproval({
            action: "SALE",
            storeId: store.id,
            requestedById: salesperson.id,
            approverRole: "STORE_MANAGER",
            status: "EXECUTED",
            summary: `开单 ${items.length} 行，原价合计 ${fmtYuan(subtotalFen)} 元，应收 ${fmtYuan(totalFen)} 元（让利 ${fmtYuan(discountFen)} 元）`,
            reasons: [{ kind: "SALE_DISCOUNT", text: `这单让利 ${fmtYuan(discountFen)} 元，占原价 ${((discountFen * 100) / subtotalFen).toFixed(1)}%，超过了 5%` }],
            amountFen: discountFen,
            payload: { action: "SALE", input: { storeId: store.id, customerId, items: items.map((i) => (i.deviceId ? { deviceId: i.deviceId, unitPriceFen: i.unitPriceFen } : { skuId: i.skuId, qty: i.qty, unitPriceFen: i.unitPriceFen })), discountFen }, details: [] },
            createdAt: asked,
            decidedById: manager.id,
            decidedAt: new Date(plan.time.getTime() - 60000),
            decisionNote: pick(["老客户，可以", "同意", "配件已经送了，优惠可以"]),
            resultId: saleId,
            resultNo: no,
          });
        }
        for (const item of items) if (item.deviceId && !serviceSkuIds.has(item.skuId)) soldDevices.push({ deviceId: item.deviceId, saleId, bizDate, customerId });
        // 少量几天后退货
        if (chance(0.015)) {
          const rd = day + between(1, 5);
          if (rd <= -1) scheduledReturns.set(rd, [...(scheduledReturns.get(rd) ?? []), saleId]);
          returnScheduled.add(saleId);
        } else if (lateReturnDay !== null) {
          scheduledReturns.set(lateReturnDay, [...(scheduledReturns.get(lateReturnDay) ?? []), saleId]);
          returnScheduled.add(saleId);
        }
      }

      // 4b. 售后：先给今天来取机的结算（收款进今天日结），再接今天的新件
      for (const r of repairPickups.get(day) ?? []) {
        const picked = at(bizDate, between(14, 20), between(0, 59));
        // 修好当天就来取的，取机时间不能早于修好时间（固定往后挪半小时，不多用随机数）
        const t = r.readyAt && picked.getTime() <= r.readyAt.getTime() ? new Date(r.readyAt.getTime() + 30 * 60000) : picked;
        r.status = "CLOSED";
        r.closedAt = t;
        r.closedById = pick(staff).id;
        r.bizDate = bizDate;
        r.updatedAt = t;
        openRepairCodes.delete(r.deviceCode);
        if (r.chargeFen > 0) {
          const method = weighted(REPAIR_METHODS, ([, w]) => w)[0];
          out.payments.push({ id: ++ids.payment, salesOrderId: null, returnOrderId: null, repairOrderId: r.id, method, amountFen: r.chargeFen, tradeInOrderId: null, reference: null, createdAt: t });
          dayPayments.push({ method, amountFen: r.chargeFen });
        }
        if (r.outcome === "REPAIRED" && r.payer === "SCREEN_INSURANCE" && r.entitlementId) {
          const e = out.entitlements[r.entitlementId - 1]!;
          e.status = "CLAIMED";
          e.updatedAt = t;
        }
        dayRepairs.push(r);
      }
      const intakes = chance(0.35 * storeFactor.get(store.id)!) ? (chance(0.25) ? 2 : 1) : 0;
      for (let k = 0; k < intakes; k++) {
        const repair = newRepair(day, bizDate, store.id, staff);
        if (!repair) continue;
        out.repairs.push(repair.rec);
        if (!repair.voided) openRepairCodes.add(repair.rec.deviceCode);
        if (repair.pickupDay !== null) repairPickups.set(repair.pickupDay, [...(repairPickups.get(repair.pickupDay) ?? []), repair.rec]);
      }

      // 5. 晚上日结：系统数 = 当天收款汇总；偶尔现金长短款
      const closeId = ++ids.close;
      const t = at(bizDate, 22, between(0, 30));
      const diffCash = chance(0.06) ? (chance(0.5) ? 1 : -1) * between(1, 50) * 100 : 0;
      out.closes.push({ id: closeId, closeNo: docNo("DC", bizDate), storeId: store.id, bizDate, status: "CONFIRMED", confirmedById: manager.id, confirmedAt: t, note: diffCash ? `现金${diffCash > 0 ? "长款" : "短款"} ${Math.abs(diffCash) / 100} 元，已登记` : null, createdAt: t, updatedAt: t });
      for (const method of ["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER", "TRADE_IN", "SUBSIDY"] as PaymentMethod[]) {
        const systemFen = dayPayments.filter((p) => p.method === method).reduce((s, p) => s + p.amountFen, 0);
        const actualFen = method === "CASH" ? systemFen + diffCash : systemFen;
        out.closeLines.push({ id: ++ids.closeLine, dailyCloseId: closeId, method, systemFen, actualFen, diffFen: actualFen - systemFen });
      }
      for (const id of daySaleIds) saleById.get(id)!.dailyCloseId = closeId;
      for (const id of dayReturnIds) out.returns[id - 1]!.dailyCloseId = closeId;
      for (const r of dayRepairs) r.dailyCloseId = closeId;
    }

    /** 接一件：七成是本店卖出去的机器（带购买记录、保修、碎屏险），三成外面买的；过去的件走完流程，最近几天的还在店里 */
    function newRepair(day: number, bizDate: Date, storeId: number, staffList: typeof staff) {
      const fault = weighted(FAULT_WEIGHTS, ([, w]) => w)[0];
      const receivedAt = at(bizDate, between(10, 20), between(0, 59));
      let deviceId: number | null = null;
      let deviceCode: string;
      let modelName: string;
      let salesOrderId: number | null = null;
      let purchasedOn: Date | null = null;
      let customerId: number;
      const candidates = soldDevices.filter((d) => daysUntil(bizDate, d.bizDate) >= 7 && !returnScheduled.has(d.saleId) && !openRepairCodes.has(out.devices[d.deviceId - 1]!.code));
      if (candidates.length > 0 && chance(0.7)) {
        const oldCandidates = candidates.filter((c) => oldSaleIds.has(c.saleId));
        const sold = oldCandidates.length > 0 && chance(0.15) ? pick(oldCandidates) : pick(candidates);
        const device = out.devices[sold.deviceId - 1]!;
        const sku = skus.find((x) => x.id === device.skuId)!;
        deviceId = device.id;
        deviceCode = device.code;
        modelName = `${sku.model.brand.name} ${sku.name}`;
        salesOrderId = sold.saleId;
        purchasedOn = sold.bizDate;
        customerId = sold.customerId ?? customerFor(true)!;
      } else {
        deviceCode = oldPhoneCode();
        modelName = pick(OLD_PHONES).name;
        customerId = customerFor(true)!;
      }
      const [partsLo, partsHi, laborLo, laborHi] = FAULT_PRICE[fault];
      const partsFen = between(partsLo, partsHi) * 100;
      const laborFen = between(laborLo, laborHi) * 100;
      const costFen = Math.round(partsFen * 0.6) + 2000;
      // 谁付：能用碎屏险、保修、延保的九成都用上，剩下自费
      const ents = deviceId ? out.entitlements.filter((e) => e.deviceId === deviceId && e.status === "ACTIVE").map((e) => ({ id: e.id, kind: SERVICE_KIND_BY_SKU.get(e.skuId)!, startedOn: e.startedOn, expiresOn: e.expiresOn })) : [];
      const options = payerOptions({ fault, today: bizDate, purchasedOn, entitlements: ents.filter((e) => e.kind !== "OTHER") });
      const covered = options.find((o) => o.payer !== "CUSTOMER" && o.allowed);
      const option = covered && chance(0.9) ? covered : options[0]!;
      const declined = option.payer === "CUSTOMER" && chance(0.1);
      const failed = !declined && chance(0.05);
      const rec: RepairRec = {
        id: ++ids.repair,
        orderNo: docNo("WX", bizDate),
        storeId,
        customerId,
        receivedById: pick(staffList).id,
        deviceId,
        deviceCode,
        modelName,
        salesOrderId,
        purchasedOn,
        faultCategory: fault,
        faultDescription: pick(FAULT_TEXT[fault]),
        appearance: pick(["边框有磕碰", "外观正常", "带手机壳，没有充电器", "背板有划痕", null]),
        status: "RECEIVED",
        partsFen: null,
        laborFen: null,
        costFen: null,
        payer: null,
        entitlementId: null,
        chargeFen: 0,
        outcome: null,
        repairNote: null,
        quotedAt: null,
        approvedAt: null,
        readyAt: null,
        closedAt: null,
        closedById: null,
        bizDate: null,
        dailyCloseId: null,
        createdAt: receivedAt,
        updatedAt: receivedAt,
      };
      // 时间线：当天报价；客户同意后 1～4 天修好；修好后 0～3 天来取。还没到的步骤就停在那一步
      const readyDay = declined ? day : day + between(1, 4);
      const pickupDay = readyDay + between(0, 3);
      if (day < -1 || chance(0.6)) { // 昨天接的件，有一些还没检测
        rec.status = "QUOTED";
        rec.quotedAt = new Date(receivedAt.getTime() + between(30, 120) * 60000);
        rec.partsFen = partsFen;
        rec.laborFen = laborFen;
        rec.costFen = costFen;
        rec.payer = option.payer;
        rec.entitlementId = option.entitlementId ?? null;
        rec.chargeFen = repairChargeFen(option.payer, partsFen, laborFen);
        rec.repairNote = pick(["检测确认故障，按报价修", "需要换件", "客户同意按报价修"]);
        if (declined) {
          rec.status = "READY";
          rec.readyAt = rec.quotedAt;
          rec.outcome = "NOT_REPAIRED";
          rec.chargeFen = 0;
          rec.repairNote = "客户嫌贵，不修了";
        } else if (readyDay <= -1 || chance(0.5)) {
          rec.status = "REPAIRING";
          rec.approvedAt = new Date(rec.quotedAt.getTime() + between(10, 60) * 60000);
          if (readyDay <= -1) {
            rec.status = "READY";
            rec.readyAt = at(bizDateOf(readyDay), between(10, 18), between(0, 59));
            rec.outcome = failed ? "NOT_REPAIRED" : "REPAIRED";
            if (failed) {
              rec.chargeFen = 0;
              rec.repairNote = "主板损坏严重，修不了，原样退回";
            }
          }
        }
      }
      rec.updatedAt = rec.readyAt ?? rec.approvedAt ?? rec.quotedAt ?? receivedAt;
      // 少数接错、重复接件的单被店长作废（按单号固定挑，不多用随机数，前面的数据不变）
      if (rec.id % 37 === 0 && day < -3) {
        Object.assign(rec, { status: "VOIDED", outcome: null, readyAt: null, approvedAt: null, chargeFen: 0, voidedAt: new Date(receivedAt.getTime() + 2 * 3600000), voidedById: (staffList.find((u) => u.role === "STORE_MANAGER") ?? staffList[0]!).id, voidReason: rec.id % 2 === 0 ? "重复接件" : "客户拿错机器，接错了" });
        rec.updatedAt = rec.voidedAt!;
        return { rec, pickupDay: null, voided: true };
      }
      return { rec, pickupDay: rec.status === "READY" && pickupDay <= -1 ? pickupDay : null, voided: false };
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

    if (stores.indexOf(store) < 3) {
      const staffer = staff.find((u) => u.role === "STAFF");
      const pool = [...inStock.entries()].find(([, list]) => list.length > 1);
      if (staffer && pool) {
        const device = pool[1][0]!;
        const sku = skus.find((x) => x.id === device.skuId)!;
        const discount = Math.round((sku.guidePriceFen * 0.1) / 1000) * 1000;
        const customerId = customerPool[customerPool.length - 1] ?? null;
        const asked = new Date(Date.now() - between(10, 40) * 60000);
        pushApproval({
          action: "SALE",
          storeId: store.id,
          requestedById: staffer.id,
          approverRole: "STORE_MANAGER",
          status: "PENDING",
          summary: `开单 1 行，原价合计 ${fmtYuan(sku.guidePriceFen)} 元，应收 ${fmtYuan(sku.guidePriceFen - discount)} 元（让利 ${fmtYuan(discount)} 元）`,
          reasons: [{ kind: "SALE_DISCOUNT", text: `这单让利 ${fmtYuan(discount)} 元，占原价 ${((discount * 100) / sku.guidePriceFen).toFixed(1)}%，超过了 5%` }],
          amountFen: discount,
          payload: { action: "SALE", input: { storeId: store.id, customerId, items: [{ deviceId: device.id, unitPriceFen: sku.guidePriceFen }], discountFen: discount, payments: [{ method: "WECHAT", amountFen: sku.guidePriceFen - discount }] }, details: [`${sku.name} ${device.code}：原价 ${fmtYuan(sku.guidePriceFen)}，成交 ${fmtYuan(sku.guidePriceFen)}`] },
          createdAt: asked,
        });
        const rejectedAt = at(bizDateOf(-3), 15, between(0, 59));
        pushApproval({
          action: "SALE",
          storeId: store.id,
          requestedById: staffer.id,
          approverRole: "STORE_MANAGER",
          status: "REJECTED",
          summary: `开单 1 行，原价合计 ${fmtYuan(sku.guidePriceFen)} 元，应收 ${fmtYuan(Math.round(sku.guidePriceFen * 0.85))} 元（让利 ${fmtYuan(sku.guidePriceFen - Math.round(sku.guidePriceFen * 0.85))} 元）`,
          reasons: [{ kind: "SALE_DISCOUNT", text: "这单让利 15.0%，超过了 5%" }],
          amountFen: sku.guidePriceFen - Math.round(sku.guidePriceFen * 0.85),
          payload: { action: "SALE", input: { storeId: store.id, items: [] }, details: [] },
          createdAt: new Date(rejectedAt.getTime() - 10 * 60000),
          decidedById: manager.id,
          decidedAt: rejectedAt,
          decisionNote: "让利太多，最多按 5% 给",
        });
      }
      if (stores.indexOf(store) === 0) {
        // 调拨：挑几台在库机器凑够 2 万元货值，调到第二家店，等总部批
        const picked: DeviceRec[] = [];
        let cost = 0;
        for (const list of inStock.values()) {
          for (const d of list.slice(1)) {
            if (cost >= 2100000) break;
            picked.push(d);
            cost += d.costFen;
          }
          if (cost >= 2100000) break;
        }
        const to = stores[1];
        if (to && cost >= 2000000) {
          pushApproval({
            action: "TRANSFER",
            storeId: store.id,
            requestedById: manager.id,
            approverRole: "HQ",
            status: "PENDING",
            summary: `${store.name} 调到 ${to.name}：机器 ${picked.length} 台、配件 0 件，货值 ${fmtYuan(cost)} 元（按成本）`,
            reasons: [{ kind: "TRANSFER", text: `调拨货值 ${fmtYuan(cost)} 元（按成本），达到了 20000 元` }],
            amountFen: cost,
            payload: { action: "TRANSFER", input: { fromStoreId: store.id, toStoreId: to.id, note: "新店缺货，先调几台", deviceIds: picked.map((d) => d.id), accessories: [] }, details: picked.map((d) => `${skus.find((x) => x.id === d.skuId)!.name} ${d.code}`) },
            createdAt: new Date(Date.now() - 50 * 60000),
          });
        }
      }
    }

    // 这家店的配件余额
    for (const [skuId, qty] of accessoryBal) accessoryRows.push({ storeId: store.id, skuId, qty });
    customerPool = customerPool.slice(-400);
  }

  buildReminders();
  buildWecomDemo(deviceSkus.map((s) => ({ id: s.id, modelName: s.model.name })), users);

  // KPI 目标：已过完的月份 = 实际 × 0.9～1.15（完成率有高有低），当月 = 上月日均 × 当月天数 × 1.05
  buildKpis(stores.map((s) => s.id));

  // 运营商业务（放最后：只用剩下的随机数）
  buildCarrierDemo(stores.map((s) => s.id), users, hq.id, storeFactor);

  await write();
  await verify();
  await prisma.$disconnect();
}

const accessoryRows: { storeId: number; skuId: number; qty: number }[] = [];

/**
 * 企业微信演示数据（口径第 12 节，模拟模式下页面不空）：店员、店长都填了企业微信账号（= 登录账号）；
 * 约三成买过东西的客户加了开单店员的企业微信并绑到档案（买了碎屏险、延保的客户加得多些），少数后来互删了；
 * 另有几十个加了好友、还没绑档案的；客户身上带几个“从企业微信同步回来”的标签（这一版没做自动打标规则）。
 */
function buildWecomDemo(deviceSkuList: { id: number; modelName: string }[], users: { id: number; username: string; role: string; storeId: number | null }[]) {
  const yesterday = bizDateOf(-1);
  const modelOf = new Map(deviceSkuList.map((s) => [s.id, s.modelName]));
  // 标签：已购机型（卖得最多的 12 个型号）、客户状态、购机年份
  const modelCount = new Map<string, number>();
  for (const item of out.saleItems) if (item.deviceId) {
    const name = modelOf.get(item.skuId);
    if (name) modelCount.set(name, (modelCount.get(name) ?? 0) + 1);
  }
  const topModels = [...modelCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name]) => name);
  const tagIds = new Map<string, number>();
  const addTag = (groupName: string, name: string) => {
    const id = out.wecomTags.length + 1;
    out.wecomTags.push({ id, groupName, tagId: `et${String(id).padStart(6, "0")}`, name, createdAt: at(bizDateOf(-95), 10, 0) });
    tagIds.set(`${groupName}|${name}`, id);
  };
  for (const m of topModels) addTag("已购机型", m);
  for (const t of ["保障中", "保险即将到期", "高价值客户"]) addTag("客户状态", t);
  addTag("购机年份", `${yesterday.getUTCFullYear()} 年购机`);

  const salesByCustomer = new Map<number, SaleRec[]>();
  for (const sale of out.sales) if (sale.customerId && sale.status === "COMPLETED") salesByCustomer.set(sale.customerId, [...(salesByCustomer.get(sale.customerId) ?? []), sale]);
  const itemsByOrder = new Map<number, SaleItemRec[]>();
  for (const item of out.saleItems) itemsByOrder.set(item.orderId, [...(itemsByOrder.get(item.orderId) ?? []), item]);
  const withService = new Set(out.entitlements.filter((e) => e.status === "ACTIVE").map((e) => e.customerId));
  const staffIds = new Set(users.filter((u) => u.role === "STAFF" || u.role === "STORE_MANAGER").map((u) => u.id));
  const usernameOf = new Map(users.map((u) => [u.id, u.username]));
  const hex = () => Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, "0");

  for (const customer of out.customers) {
    const sales = salesByCustomer.get(customer.id as number);
    if (!sales || sales.length === 0) continue;
    if (!chance(withService.has(customer.id as number) ? 0.6 : 0.25)) continue;
    const last = sales[sales.length - 1]!;
    if (!staffIds.has(last.salespersonId)) continue;
    const externalUserid = `wm${hex()}${hex()}`;
    const addedAt = new Date(last.createdAt.getTime() + between(2, 10) * 60000);
    customer.wecomExternalUserid = externalUserid;
    customer.wecomNickname = `微信用户${externalUserid.slice(-4).toUpperCase()}`;
    customer.wecomBoundAt = addedAt;
    const deleted = chance(0.05);
    out.wecomFollows.push({
      id: out.wecomFollows.length + 1,
      externalUserid,
      wecomUserid: usernameOf.get(last.salespersonId)!,
      userId: last.salespersonId,
      customerId: customer.id,
      status: deleted ? "DELETED" : "ACTIVE",
      deletedBy: deleted ? "CUSTOMER" : null,
      state: `o${hex()}`.slice(0, 9),
      firstAddAt: addedAt,
      deletedAt: deleted ? new Date(Math.min(addedAt.getTime() + between(3, 40) * DAY_MS, at(yesterday, 20, 0).getTime())) : null,
      createdAt: addedAt,
      updatedAt: addedAt,
    });
    // 标签：买过的机型、今年购机、保障状态、累计消费
    const tags = new Set<string>([`购机年份|${yesterday.getUTCFullYear()} 年购机`]);
    for (const sale of sales) for (const item of itemsByOrder.get(sale.id) ?? []) {
      const name = item.deviceId ? modelOf.get(item.skuId) : undefined;
      if (name && tagIds.has(`已购机型|${name}`)) tags.add(`已购机型|${name}`);
    }
    const active = out.entitlements.filter((e) => e.customerId === customer.id && e.status === "ACTIVE" && daysUntil(e.expiresOn, yesterday) >= 0);
    if (active.length > 0) tags.add("客户状态|保障中");
    if (active.some((e) => daysUntil(e.expiresOn, yesterday) <= 30)) tags.add("客户状态|保险即将到期");
    if (sales.reduce((sum, x) => sum + x.totalFen, 0) >= 1_000_000) tags.add("客户状态|高价值客户");
    for (const key of tags) out.wecomCustomerTags.push({ customerId: customer.id, tagId: tagIds.get(key)!, source: "WECOM", createdAt: addedAt });
  }
  // 加了好友、还没绑档案的：别的渠道来的（门店海报、朋友介绍），等员工认领
  const staffList = users.filter((u) => staffIds.has(u.id));
  for (let i = 0; i < 40; i++) {
    const staff = pick(staffList);
    const addedAt = at(bizDateOf(-between(1, 60)), between(10, 21), between(0, 59));
    out.wecomFollows.push({ id: out.wecomFollows.length + 1, externalUserid: `wm${hex()}${hex()}`, wecomUserid: staff.username, userId: staff.id, customerId: null, status: "ACTIVE", deletedBy: null, state: null, firstAddAt: addedAt, deletedAt: null, createdAt: addedAt, updatedAt: addedAt });
  }
}

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
  const firstDay = bizDateOf(-DAYS);
  const months = new Set<string>(out.sales.filter((s) => s.bizDate >= firstDay).map((s) => monthKey(s.bizDate)));
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

/**
 * 运营商业务演示数据（口径第 14 节）：4 个运营商 × 5 种业务的佣金政策（广电合约机故意不配）；每家店每天 0～2 笔号卡、合约机、宽带，
 * 合约机挂当天本店有客户的大额销售单；最近两天的大多还是“已登记”（留给演示点“同步运营商状态”），更早的基本都开通了，少数失败、作废。
 * 已经过完的月份里，最近一个月留给演示“生成模拟结算单”，更早的都按模拟结算单对过账（同一套对账函数）。
 * 放在最后生成：只用剩下的随机数，前面的销售、回收、维修等数据不受影响。
 */
const CARRIER_RULES: [CarrierKey, CarrierBizTypeKey, number, number][] = [
  ["CMCC", "NEW_LINE", 8000, 6], ["CMCC", "PORT_IN", 15000, 6], ["CMCC", "CONTRACT_PHONE", 20000, 12], ["CMCC", "BROADBAND", 12000, 12], ["CMCC", "PLAN_UPGRADE", 3000, 3],
  ["CUCC", "NEW_LINE", 7000, 6], ["CUCC", "PORT_IN", 14000, 6], ["CUCC", "CONTRACT_PHONE", 18000, 12], ["CUCC", "BROADBAND", 11000, 12], ["CUCC", "PLAN_UPGRADE", 2500, 3],
  ["CTCC", "NEW_LINE", 7500, 6], ["CTCC", "PORT_IN", 14000, 6], ["CTCC", "CONTRACT_PHONE", 19000, 12], ["CTCC", "BROADBAND", 13000, 12], ["CTCC", "PLAN_UPGRADE", 2500, 3],
  ["CBN", "NEW_LINE", 6000, 6], ["CBN", "PORT_IN", 12000, 6], ["CBN", "BROADBAND", 9000, 12], ["CBN", "PLAN_UPGRADE", 2000, 3],
];
const CARRIER_WEIGHTS: [CarrierKey, number][] = [["CMCC", 45], ["CUCC", 25], ["CTCC", 25], ["CBN", 5]];
const CARRIER_TYPE_WEIGHTS: [CarrierBizTypeKey, number][] = [["NEW_LINE", 30], ["PORT_IN", 12], ["CONTRACT_PHONE", 15], ["BROADBAND", 20], ["PLAN_UPGRADE", 23]];
const CARRIER_PACKAGES: Record<CarrierBizTypeKey, [string, number | null][]> = {
  NEW_LINE: [["5G 畅享 129 元套餐", 12900], ["5G 智享 99 元套餐", 9900], ["59 元基础套餐", 5900], ["39 元流量王卡", 3900]],
  PORT_IN: [["携转 99 元融合套餐", 9900], ["携转 129 元套餐", 12900]],
  CONTRACT_PHONE: [["购机送费 199 元档 24 个月", 19900], ["购机送费 129 元档 24 个月", 12900], ["购机直降 99 元档 12 个月", 9900]],
  BROADBAND: [["千兆宽带 1 年", null], ["300M 宽带 1 年", null], ["融合宽带（手机 + 宽带）", 15900]],
  PLAN_UPGRADE: [["79 升 129 元套餐", 12900], ["59 升 99 元套餐", 9900], ["加 30G 流量包", 3000]],
};
const CARRIER_ORDER_PREFIX: Record<CarrierKey, string> = { CMCC: "CM", CUCC: "CU", CTCC: "CT", CBN: "CB" };
const CARRIER_FAIL_REASONS = ["客户实名核验没过", "号码已被占用", "宽带地址不在覆盖范围", "客户临时不办了"];
interface CarrierRec {
  id: number;
  orderNo: string;
  storeId: number;
  handledById: number;
  customerId: number | null;
  carrier: CarrierKey;
  bizType: CarrierBizTypeKey;
  phone: string;
  packageName: string;
  monthlyFeeFen: number | null;
  carrierOrderNo: string | null;
  salesOrderId: number | null;
  bizDate: Date;
  expectedCommissionFen: number;
  clawbackMonths: number;
  status: "SUBMITTED" | "ACTIVATED" | "FAILED" | "SETTLED" | "CLAWED_BACK" | "VOIDED";
  activatedAt: Date | null;
  failedReason: string | null;
  settlementId: number | null;
  settledFen: number | null;
  clawbackFen: number | null;
  voidedAt: Date | null;
  voidedById: number | null;
  voidReason: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}
const carrierOut = { rules: [] as Row[], business: [] as CarrierRec[], settlements: [] as Row[], lines: [] as Row[] };

function buildCarrierDemo(storeIds: number[], users: { id: number; role: string; storeId: number | null }[], hqId: number, storeFactor: Map<number, number>) {
  const now = new Date();
  const ruleOf = new Map(CARRIER_RULES.map(([c, t, fen, months]) => [`${c}-${t}`, { fen, months }]));
  const ruleTime = at(bizDateOf(-DAYS), 9, 0);
  CARRIER_RULES.forEach(([carrier, bizType, commissionFen, clawbackMonths], i) => carrierOut.rules.push({ id: i + 1, carrier, bizType, commissionFen, clawbackMonths, isActive: true, note: "2026 年下半年渠道政策", createdAt: ruleTime, updatedAt: ruleTime }));
  // 合约机：当天本店有客户、金额过千五的销售单（买新机）
  const bigSales = new Map<string, SaleRec[]>();
  for (const s of out.sales) {
    if (s.status !== "COMPLETED" || !s.customerId || s.totalFen < 150000) continue;
    const k = `${s.storeId}-${s.bizDate.getTime()}`;
    bigSales.set(k, [...(bigSales.get(k) ?? []), s]);
  }
  const customerPhone = new Map(out.customers.map((c) => [c.id as number, c.phone as string]));
  let seq = 0;
  let orderSeq = 0;
  for (const storeId of storeIds) {
    const staff = users.filter((u) => u.storeId === storeId && (u.role === "STAFF" || u.role === "STORE_MANAGER"));
    const manager = staff.find((u) => u.role === "STORE_MANAGER");
    if (staff.length === 0) continue;
    for (let day = -DAYS; day <= -1; day++) {
      const bizDate = bizDateOf(day);
      const n = chance(0.5 * storeFactor.get(storeId)!) ? (chance(0.3) ? 2 : 1) : 0;
      const usedSales = new Set<number>();
      for (let k = 0; k < n; k++) {
        let bizType = weighted(CARRIER_TYPE_WEIGHTS, ([, w]) => w)[0];
        let carrier = weighted(CARRIER_WEIGHTS, ([, w]) => w)[0];
        let sale: SaleRec | undefined;
        if (bizType === "CONTRACT_PHONE") {
          sale = (bigSales.get(`${storeId}-${bizDate.getTime()}`) ?? []).find((s) => !usedSales.has(s.id));
          if (sale) usedSales.add(sale.id);
          else bizType = "NEW_LINE";
          if (carrier === "CBN" && bizType === "CONTRACT_PHONE") carrier = "CMCC"; // 广电合约机没配政策
        }
        const rule = ruleOf.get(`${carrier}-${bizType}`)!;
        const customerId = sale ? sale.customerId : chance(0.45) && out.customers.length > 0 ? (pick(out.customers).id as number) : null;
        const phone = customerId && (bizType === "PORT_IN" || bizType === "PLAN_UPGRADE" || bizType === "BROADBAND") ? customerPhone.get(customerId)! : newPhone();
        const [packageName, monthlyFeeFen] = pick(CARRIER_PACKAGES[bizType]);
        const handledById = sale ? sale.salespersonId : pick(staff).id;
        const createdAt = sale ? new Date(sale.createdAt.getTime() + between(5, 30) * 60000) : at(bizDate, between(10, 20), between(0, 59));
        const rec: CarrierRec = {
          id: ++seq,
          orderNo: docNo("YY", bizDate),
          storeId,
          handledById,
          customerId,
          carrier,
          bizType,
          phone,
          packageName,
          monthlyFeeFen,
          carrierOrderNo: chance(0.85) ? `${CARRIER_ORDER_PREFIX[carrier]}${ymd(bizDate)}${String(++orderSeq).padStart(6, "0")}` : null,
          salesOrderId: sale?.id ?? null,
          bizDate,
          expectedCommissionFen: rule.fen,
          clawbackMonths: rule.months,
          status: "SUBMITTED",
          activatedAt: null,
          failedReason: null,
          settlementId: null,
          settledFen: null,
          clawbackFen: null,
          voidedAt: null,
          voidedById: null,
          voidReason: null,
          note: null,
          createdAt,
          updatedAt: createdAt,
        };
        // 最近两天的大多还没确认；更早的基本都开通了
        const r = rnd();
        const recent = day >= -2;
        if (recent ? r < 0.35 : r < 0.93) {
          rec.status = "ACTIVATED";
          rec.activatedAt = new Date(Math.min(createdAt.getTime() + between(2, recent ? 20 : 40) * 3600000, now.getTime() - 3600000));
          rec.updatedAt = rec.activatedAt;
        } else if (recent ? r < 0.4 : r < 0.98) {
          rec.status = "FAILED";
          rec.failedReason = pick(CARRIER_FAIL_REASONS);
          rec.updatedAt = new Date(createdAt.getTime() + between(1, 6) * 3600000);
        } else if (!recent) {
          rec.status = "VOIDED";
          rec.voidedAt = new Date(createdAt.getTime() + between(1, 3) * 3600000);
          rec.voidedById = manager?.id ?? hqId;
          rec.voidReason = pick(["登记重复了", "号码填错了，重新登记"]);
          rec.updatedAt = rec.voidedAt;
        }
        carrierOut.business.push(rec);
      }
    }
  }

  // 已过完的月份：最近一个留给演示，更早的按模拟结算单对过账
  const currentMonth = bizDateOf(0).toISOString().slice(0, 7);
  const months = [...new Set(carrierOut.business.map((b) => b.bizDate.toISOString().slice(0, 7)))].filter((m) => m < currentMonth).sort();
  const byId = new Map(carrierOut.business.map((b) => [b.id, b]));
  let lineSeq = 0;
  for (const month of months.slice(0, -1)) {
    const { from, to } = monthRange(month);
    const importDate = new Date(to.getTime() + 4 * DAY_MS); // 次月 5 号导入
    for (const [carrier] of CARRIER_WEIGHTS) {
      const candidates = carrierOut.business.filter((b) => b.carrier === carrier && (b.status === "ACTIVATED" || b.status === "SETTLED") && b.bizDate < to);
      const lines: StatementLine[] = [];
      for (const b of candidates.filter((c) => c.status === "ACTIVATED" && c.bizDate >= from)) {
        const r = rnd();
        if (r < 0.02) continue; // 运营商漏给
        lines.push({ carrierOrderNo: b.carrierOrderNo, phone: b.phone, bizType: b.bizType, commissionFen: r < 0.05 ? Math.max(0, b.expectedCommissionFen - 1000) : b.expectedCommissionFen, clawbackFen: 0 });
      }
      for (const b of candidates.filter((c) => c.status === "SETTLED")) if (chance(0.04)) lines.push({ carrierOrderNo: b.carrierOrderNo, phone: b.phone, bizType: b.bizType, commissionFen: 0, clawbackFen: b.settledFen ?? 0 });
      if (chance(0.5)) lines.push({ carrierOrderNo: `${CARRIER_ORDER_PREFIX[carrier]}${month.replace("-", "")}X${between(100, 999)}`, phone: newPhone(), bizType: "NEW_LINE", commissionFen: ruleOf.get(`${carrier}-NEW_LINE`)!.fen, clawbackFen: 0 });
      if (lines.length === 0) continue;
      const result = reconcileStatement(lines, candidates.map((c) => ({ ...c, inMonth: c.bizDate >= from && c.bizDate < to })));
      const settlementId = carrierOut.settlements.length + 1;
      const t = at(importDate, 10, between(0, 59));
      carrierOut.settlements.push({
        id: settlementId,
        settlementNo: docNo("JS", importDate),
        carrier,
        month,
        source: "SIMULATED",
        importedById: hqId,
        lineCount: lines.length,
        matchedCount: result.lines.filter((l) => l.result === "MATCHED").length,
        diffCount: result.lines.filter((l) => l.result === "DIFF").length,
        unmatchedCount: result.lines.filter((l) => l.result === "UNMATCHED").length,
        missingCount: result.missing.length,
        totalCommissionFen: lines.reduce((s, l) => s + l.commissionFen, 0),
        totalClawbackFen: lines.reduce((s, l) => s + l.clawbackFen, 0),
        createdAt: t,
      });
      for (const l of result.lines) carrierOut.lines.push({ id: ++lineSeq, settlementId, carrierOrderNo: l.carrierOrderNo, phone: l.phone, bizType: l.bizType, commissionFen: l.commissionFen, clawbackFen: l.clawbackFen, businessId: l.businessId, result: l.result });
      for (const s of result.settle) Object.assign(byId.get(s.id)!, { status: "SETTLED", settledFen: s.settledFen, settlementId, updatedAt: t });
      for (const c of result.clawback) Object.assign(byId.get(c.id)!, { status: "CLAWED_BACK", clawbackFen: c.clawbackFen, updatedAt: t });
    }
  }
}

/** 开票（口径第 16 节）：开单后几分钟申请；用了国补的当天就开（国补提交审核要发票号），其余一两天内开，最近一两天的一半还没开 */
function makeInvoice(sale: SaleRec, items: SaleItemRec[], claim: SubsidyRec | null, requestedById: number, day: number) {
  const lines = buildInvoiceLines(
    items.map((i) => ({ salesOrderItemId: i.id, name: skuNames.get(i.skuId) ?? "商品", spec: i.deviceId ? out.devices[i.deviceId - 1]!.code : null, qty: i.qty, returnedQty: 0, lineTotalFen: i.lineTotalFen, isService: serviceSkuIdSet.has(i.skuId) })),
    sale,
  );
  if (lines.length === 0) return;
  const kind: InvoiceKindKey = claim ? "E_NORMAL" : weighted([["E_NORMAL", 75], ["PAPER_NORMAL", 15], ["E_SPECIAL", 10]] as [InvoiceKindKey, number][], ([, w]) => w)[0];
  const company = kind === "E_SPECIAL" || (!claim && chance(0.15));
  const customer = out.customers[sale.customerId! - 1]!;
  const createdAt = new Date(sale.createdAt.getTime() + between(5, 40) * 60000);
  const now = new Date();
  const id = out.invoices.length + 1;
  const inv: InvoiceRec = {
    id,
    requestNo: docNo("KP", sale.bizDate),
    storeId: sale.storeId,
    salesOrderId: sale.id,
    customerId: sale.customerId,
    kind,
    titleType: company ? "COMPANY" : "PERSONAL",
    titleName: company ? pick(COMPANY_TITLES) : (customer.name as string),
    buyerTaxNo: company ? `91440300${String(between(10000000, 99999999))}AB` : null,
    buyerAddressPhone: kind === "E_SPECIAL" ? "深圳市福田区演示大道 88 号 0755-87654321" : null,
    buyerBankAccount: kind === "E_SPECIAL" ? "工商银行深圳福田支行 4000000000000000001" : null,
    receiver: kind === "PAPER_NORMAL" ? null : chance(0.6) ? (customer.phone as string) : null,
    amountFen: lines.reduce((x, l) => x + l.amountFen, 0),
    taxFen: lines.reduce((x, l) => x + l.taxFen, 0),
    status: "REQUESTED",
    requestedById,
    invoiceNumber: null,
    issueSource: null,
    issuedAt: null,
    issuedById: null,
    sellerSnapshot: null,
    deliveredAt: null,
    redNumber: null,
    redAt: null,
    redById: null,
    redReason: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt,
    updatedAt: createdAt,
  };
  const age = -day;
  if (claim || age > 1 || chance(0.5)) {
    const issuedAt = new Date(Math.min(createdAt.getTime() + (claim ? between(10, 60) * 60000 : between(1, 26) * 3600000), now.getTime() - 3600000));
    inv.status = "ISSUED";
    inv.issuedAt = issuedAt;
    inv.issuedById = hqId;
    inv.issueSource = "SIMULATED";
    inv.invoiceNumber = simulateInvoiceNumber(++invoiceNumberSeq, issuedAt);
    inv.sellerSnapshot = DEMO_SELLER;
    inv.updatedAt = issuedAt;
    if (kind === "PAPER_NORMAL") {
      const delivered = new Date(issuedAt.getTime() + between(2, 4) * DAY_MS);
      if (delivered < now) inv.deliveredAt = delivered;
    }
    if (claim?.invoiceNo) claim.invoiceNo = inv.invoiceNumber; // 国补单提交审核时带的就是这张发票
  }
  out.invoices.push(inv);
  for (const l of lines) out.invoiceLines.push({ id: out.invoiceLines.length + 1, invoiceId: id, ...l });
  invoiceBySale.set(sale.id, inv);
}

/** 退货之后：还没开的撤回；开了的要红冲，三天以前的退货总部已经红冲了 */
function invoiceAfterReturn(inv: InvoiceRec, t: Date, day: number) {
  if (inv.status !== "ISSUED" || !inv.issuedAt || inv.issuedAt > t) {
    Object.assign(inv, { status: "CANCELLED", invoiceNumber: null, issueSource: null, issuedAt: null, issuedById: null, sellerSnapshot: null, deliveredAt: null, cancelledAt: t, cancelReason: "销售单退货，自动撤回；要开票按剩下的商品重新申请", updatedAt: t });
    return;
  }
  inv.status = "RED_PENDING";
  inv.cancelReason = "销售单退货，要红冲";
  inv.updatedAt = t;
  if (day <= -3) {
    const redAt = new Date(t.getTime() + DAY_MS);
    Object.assign(inv, { status: "REDDED", redAt, redById: hqId, redNumber: simulateInvoiceNumber(++invoiceNumberSeq, redAt), redReason: "退货", updatedAt: redAt });
  }
}

/** 国补单按开单后过了几天推进：两三天内多半还没提交；一两周在审核；一个月以上基本都到账了，少数被驳回 */
const SUBSIDY_REJECT_REASONS = ["发票抬头和顾客实名不一致", "串号照片看不清", "成交价和发票金额对不上"];
function advanceClaim(c: SubsidyRec, age: number) {
  const now = new Date();
  const cap = (d: Date) => new Date(Math.min(d.getTime(), now.getTime() - 3600000));
  const r = rnd();
  const target: SubsidyStatusKey =
    age <= 3 ? (r < 0.7 ? "PENDING" : "SUBMITTED")
    : age <= 14 ? (r < 0.05 ? "PENDING" : r < 0.55 ? "SUBMITTED" : r < 0.95 ? "APPROVED" : "REJECTED")
    : age <= 40 ? (r < 0.03 ? "SUBMITTED" : r < 0.33 ? "APPROVED" : r < 0.95 ? "SETTLED" : "REJECTED")
    : r < 0.01 ? "APPROVED" : r < 0.95 ? "SETTLED" : "REJECTED";
  if (target === "PENDING") return;
  c.invoiceNo = `FP${ymd(c.bizDate)}${String(c.id).padStart(6, "0")}`;
  c.submittedAt = cap(new Date(c.createdAt.getTime() + between(2, 40) * 3600000));
  c.status = "SUBMITTED";
  c.updatedAt = c.submittedAt;
  if (target === "SUBMITTED") return;
  c.reviewedAt = cap(new Date(c.submittedAt.getTime() + between(2, 7) * DAY_MS));
  c.updatedAt = c.reviewedAt;
  if (target === "REJECTED") {
    c.status = "REJECTED";
    c.rejectReason = pick(SUBSIDY_REJECT_REASONS);
    return;
  }
  c.status = "APPROVED";
  if (target === "APPROVED") return;
  c.settledAt = cap(new Date(c.reviewedAt.getTime() + between(4, 12) * DAY_MS));
  c.settledFen = c.subsidyFen;
  c.status = "SETTLED";
  c.updatedAt = c.settledAt;
}

/** 作废、退货时的国补单：到账在这之前的要退回平台，没到账的撤销（这之后才会发生的提交、审核、到账都不算） */
function cancelClaim(c: SubsidyRec, t: Date, day = 0) {
  if (c.settledAt && c.settledAt < t) {
    c.status = "RETURN_DUE";
    c.cancelledAt = t;
    c.updatedAt = t;
    // 一周以前退的，总部已经把钱退回平台了
    if (day <= -7) {
      c.status = "RETURNED";
      c.returnedAt = new Date(t.getTime() + 3 * DAY_MS);
      c.updatedAt = c.returnedAt;
    }
    return;
  }
  if (c.submittedAt && c.submittedAt > t) {
    c.submittedAt = null;
    c.invoiceNo = null;
  }
  if (c.reviewedAt && c.reviewedAt > t) {
    c.reviewedAt = null;
    c.rejectReason = null;
  }
  c.settledAt = null;
  c.settledFen = null;
  c.status = "CANCELLED";
  c.cancelledAt = t;
  c.updatedAt = t;
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
  await insert("服务权益", out.entitlements as unknown as Row[], (c) => prisma.serviceEntitlement.createMany({ data: c as never }));
  await insert("维修单", out.repairs as unknown as Row[], (c) => prisma.repairOrder.createMany({ data: c as never }));
  await insert("收款", out.payments as unknown as Row[], (c) => prisma.payment.createMany({ data: c as never }));
  await prisma.invoiceSeller.create({ data: { id: 1, ...DEMO_SELLER } });
  await insert("审批规则", DEMO_APPROVAL_RULES as unknown as Row[], (c) => prisma.approvalRule.createMany({ data: c as never }));
  await insert("审批单", out.approvals, (c) => prisma.approvalRequest.createMany({ data: c as never }));
  await insert("发票", out.invoices as unknown as Row[], (c) => prisma.invoice.createMany({ data: c as never }));
  await insert("发票明细", out.invoiceLines, (c) => prisma.invoiceLine.createMany({ data: c as never }));
  await insert("国补政策", out.subsidyPolicies, (c) => prisma.subsidyPolicy.createMany({ data: c as never }));
  await insert("国补单", out.subsidyClaims as unknown as Row[], (c) => prisma.subsidyClaim.createMany({ data: c as never }));
  await insert("运营商佣金政策", carrierOut.rules, (c) => prisma.carrierCommissionRule.createMany({ data: c as never }));
  await insert("运营商结算单", carrierOut.settlements, (c) => prisma.carrierSettlement.createMany({ data: c as never }));
  await insert("运营商业务", carrierOut.business as unknown as Row[], (c) => prisma.carrierBusiness.createMany({ data: c as never }));
  await insert("运营商结算明细", carrierOut.lines, (c) => prisma.carrierSettlementLine.createMany({ data: c as never }));
  await insert("到期提醒", out.reminders, (c) => prisma.entitlementReminder.createMany({ data: c as never }));
  // 企业微信：店员、店长、总部的企业微信账号 = 登录账号（演示用；总部现场开单也能生成加微二维码）
  await prisma.$executeRaw`UPDATE users SET wecom_userid = username WHERE role IN ('STAFF', 'STORE_MANAGER', 'HQ') AND is_active`;
  await insert("企微跟进关系", out.wecomFollows, (c) => prisma.wecomFollow.createMany({ data: c as never }));
  await insert("企微标签", out.wecomTags, (c) => prisma.wecomTag.createMany({ data: c as never }));
  await insert("客户标签", out.wecomCustomerTags, (c) => prisma.wecomCustomerTag.createMany({ data: c as never }));
  await insert("配件库存", accessoryRows, (c) => prisma.accessoryStock.createMany({ data: c as never }));
  await insert("库存流水", out.ledgers, (c) => prisma.stockLedger.createMany({ data: c as never }));
  await insert("KPI 目标", out.kpis, (c) => prisma.kpiTarget.createMany({ data: c as never }));
  for (const [key, value] of docCounters) {
    await prisma.docCounter.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  // 自己指定了 id，自增序列要跟上，后面正常开单才不会撞号
  const tables = ["customers", "purchase_orders", "purchase_order_items", "goods_receipts", "goods_receipt_items", "trade_in_orders", "devices", "daily_closes", "daily_close_lines", "sales_orders", "sales_order_items", "return_orders", "return_order_items", "payments", "accessory_stocks", "stock_ledgers", "kpi_targets", "service_entitlements", "entitlement_reminders", "wecom_follows", "wecom_tags", "repair_orders", "carrier_commission_rules", "carrier_settlements", "carrier_business", "carrier_settlement_lines", "subsidy_policies", "subsidy_claims", "invoices", "invoice_lines", "approval_rules", "approval_requests"];
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM "${t}"), 0), 1), (SELECT COUNT(*) > 0 FROM "${t}"))`);
  }
}

/** 自检：对账 SQL 抽到 integrity-checks.ts，上线后 pnpm db:check 也用同一套 */
async function verify() {
  const result = await runIntegrityChecks(prisma);
  const sales = out.sales.filter((s) => s.status === "COMPLETED");
  console.log(
    `模拟数据完成：${sales.length} 张有效销售单（作废 ${out.sales.length - sales.length}）、${out.tradeIns.length} 张回收单、${out.returns.length} 张退货单、${out.devices.length} 台机器、${out.closes.length} 次日结、${out.entitlements.length} 份碎屏险和延保、${out.repairs.length} 张维修单、${out.subsidyClaims.length} 张国补单、${out.invoices.length} 张发票、${out.approvals.length} 张审批单、${carrierOut.business.length} 笔运营商业务（${carrierOut.settlements.length} 张往月结算单）、${out.wecomFollows.length} 条企业微信好友关系。`,
  );
  console.log(`自检：${describeIntegrity(result)}`);
  if (!integrityOk(result)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
