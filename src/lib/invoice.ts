// 发票（口径第 16 节）：名称、明细和税额怎么算、抬头校验、模拟发票号码。纯函数，页面、服务层、演示数据生成共用，单元测试见 tests/invoice.test.ts。

export type InvoiceKindKey = "E_NORMAL" | "E_SPECIAL" | "PAPER_NORMAL";
export type InvoiceTitleTypeKey = "PERSONAL" | "COMPANY";
export type InvoiceStatusKey = "REQUESTED" | "ISSUED" | "RED_PENDING" | "REDDED" | "CANCELLED";

export const INVOICE_KINDS: InvoiceKindKey[] = ["E_NORMAL", "E_SPECIAL", "PAPER_NORMAL"];
export const INVOICE_KIND_LABELS: Record<InvoiceKindKey, string> = { E_NORMAL: "电子普票", E_SPECIAL: "电子专票", PAPER_NORMAL: "纸质普票" };
export const INVOICE_TITLE_TYPE_LABELS: Record<InvoiceTitleTypeKey, string> = { PERSONAL: "个人", COMPANY: "企业" };
export const INVOICE_STATUS_LABELS: Record<InvoiceStatusKey, string> = { REQUESTED: "待开票", ISSUED: "已开票", RED_PENDING: "需红冲", REDDED: "已红冲", CANCELLED: "已撤回" };
export const INVOICE_STATUS_COLORS: Record<InvoiceStatusKey, string> = { REQUESTED: "blue", ISSUED: "green", RED_PENDING: "orange", REDDED: "default", CANCELLED: "default" };
/** 在办的：一张销售单同时只能有一张 */
export const INVOICE_ACTIVE_STATUSES: InvoiceStatusKey[] = ["REQUESTED", "ISSUED", "RED_PENDING"];

/** 税率（万分之几）：商品 13%，碎屏险、延保这类服务 6% */
export const TAX_RATE_GOODS_BP = 1300;
export const TAX_RATE_SERVICE_BP = 600;

/** 含税金额里的税额：金额 × 税率 ÷（1 + 税率），四舍五入到分 */
export function taxOf(amountFen: number, rateBp: number): number {
  return Math.round((amountFen * rateBp) / (10000 + rateBp));
}

export interface InvoiceSourceItem {
  salesOrderItemId: number;
  name: string;
  spec: string | null; // 机器写串号
  qty: number;
  returnedQty: number;
  lineTotalFen: number;
  isService: boolean;
}

export interface InvoiceLineDraft {
  salesOrderItemId: number;
  name: string;
  spec: string | null;
  qty: number;
  amountFen: number;
  taxRateBp: number;
  taxFen: number;
}

/**
 * 发票明细（口径第 16 节）：整单优惠按成交额比例分摊到每一行（分摊的尾差给最后一行，合计正好等于应收），
 * 再按还没退的件数折算；金额是 0 的行不开。以旧换新抵扣、国补立减是收款方式，不减发票金额。
 */
export function buildInvoiceLines(items: InvoiceSourceItem[], order: { subtotalFen: number; totalFen: number }): InvoiceLineDraft[] {
  if (order.subtotalFen <= 0 || items.length === 0) return [];
  const shares = items.map((i) => Math.round((i.lineTotalFen * order.totalFen) / order.subtotalFen));
  shares[shares.length - 1]! += order.totalFen - shares.reduce((s, x) => s + x, 0);
  const lines: InvoiceLineDraft[] = [];
  items.forEach((item, index) => {
    const qty = item.qty - item.returnedQty;
    if (qty <= 0) return;
    const amountFen = Math.round((shares[index]! * qty) / item.qty);
    if (amountFen <= 0) return;
    const taxRateBp = item.isService ? TAX_RATE_SERVICE_BP : TAX_RATE_GOODS_BP;
    lines.push({ salesOrderItemId: item.salesOrderItemId, name: item.name, spec: item.spec, qty, amountFen, taxRateBp, taxFen: taxOf(amountFen, taxRateBp) });
  });
  return lines;
}

export class InvoiceRuleError extends Error {}

// 统一社会信用代码（GB 32100-2015）：18 位，字符集没有 I、O、Z、S、V；第 18 位是前 17 位按权重算出来的校验码
const USCC_CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/** 前 17 位算出来的校验码；位数不对或有不用的字母返回 null */
export function usccCheckChar(first17: string): string | null {
  if (first17.length !== 17) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const value = USCC_CHARS.indexOf(first17[i]!);
    if (value < 0) return null;
    sum += value * USCC_WEIGHTS[i]!;
  }
  return USCC_CHARS[(31 - (sum % 31)) % 31]!;
}

/**
 * 纳税人识别号有什么问题（没问题返回 null；传进来的要先转大写）：
 * 18 位的就是统一社会信用代码，查字符和校验位；15、17、19、20 位的老号码（老税务登记号、个体户身份证号加两位）只查字母数字。
 */
export function taxNoProblem(taxNo: string): string | null {
  if (!/^[0-9A-Z]{15,20}$/.test(taxNo)) return "纳税人识别号是 15～20 位字母数字（统一社会信用代码 18 位）";
  if (taxNo.length === 18 && usccCheckChar(taxNo.slice(0, 17)) !== taxNo[17]) return "统一社会信用代码不对：里面不会有 I、O、Z、S、V，最后一位是校验码，核对一下";
  return null;
}

export interface InvoiceTitleInput {
  kind: unknown;
  titleType: unknown;
  titleName: unknown;
  buyerTaxNo?: unknown;
  buyerAddressPhone?: unknown;
  buyerBankAccount?: unknown;
  receiver?: unknown;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 抬头校验：企业要税号；专票只能开给企业，还要地址电话、开户行账号；电子票的接收方是邮箱或手机（可不填） */
export function validateInvoiceTitle(input: InvoiceTitleInput) {
  const kind = input.kind as InvoiceKindKey;
  if (!INVOICE_KINDS.includes(kind)) throw new InvoiceRuleError("请选发票种类");
  const titleType = input.titleType as InvoiceTitleTypeKey;
  if (titleType !== "PERSONAL" && titleType !== "COMPANY") throw new InvoiceRuleError("请选抬头是个人还是企业");
  const titleName = text(input.titleName, 100);
  if (!titleName) throw new InvoiceRuleError(titleType === "COMPANY" ? "填一下公司名称" : "填一下抬头（个人写姓名）");
  if (kind === "E_SPECIAL" && titleType !== "COMPANY") throw new InvoiceRuleError("专票只能开给企业");
  const buyerTaxNo = text(input.buyerTaxNo, 20).toUpperCase() || null;
  if (titleType === "COMPANY" && !buyerTaxNo) throw new InvoiceRuleError("企业抬头要填纳税人识别号");
  const taxProblem = buyerTaxNo ? taxNoProblem(buyerTaxNo) : null;
  if (taxProblem) throw new InvoiceRuleError(taxProblem);
  const buyerAddressPhone = text(input.buyerAddressPhone, 100) || null;
  const buyerBankAccount = text(input.buyerBankAccount, 100) || null;
  if (kind === "E_SPECIAL" && (!buyerAddressPhone || !buyerBankAccount)) throw new InvoiceRuleError("专票要填公司地址电话、开户行及账号");
  const receiver = text(input.receiver, 60) || null;
  if (receiver && !/^1\d{10}$/.test(receiver) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiver)) throw new InvoiceRuleError("接收方填邮箱或 11 位手机号");
  return { kind, titleType, titleName, buyerTaxNo: titleType === "COMPANY" ? buyerTaxNo : null, buyerAddressPhone: titleType === "COMPANY" ? buyerAddressPhone : null, buyerBankAccount: titleType === "COMPANY" ? buyerBankAccount : null, receiver: kind === "PAPER_NORMAL" ? null : receiver };
}

/** 税务发票号码：数电票 20 位数字；纸质票 8 位号码前面带 10～12 位代码也认（登记时去掉空格横线） */
export function normalizeInvoiceNumber(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.replace(/[\s-]/g, "") : "";
  return /^\d{8,20}$/.test(s) ? s : null;
}

/** 模拟开具的数电票号码（演示用）：年份后两位 + 地区 44 + 开票日 + 流水，共 20 位 */
export function simulateInvoiceNumber(seq: number, at: Date): string {
  const yy = at.toISOString().slice(2, 4);
  const mmdd = at.toISOString().slice(5, 10).replace("-", "");
  return `${yy}44${mmdd}${String(seq % 1e12).padStart(12, "0")}`;
}
