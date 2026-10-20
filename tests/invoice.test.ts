import { describe, expect, it } from "vitest";
import { buildInvoiceLines, InvoiceRuleError, normalizeInvoiceNumber, simulateInvoiceNumber, taxOf, validateInvoiceTitle, taxNoProblem, usccCheckChar } from "@/lib/invoice";

// 发票（口径第 16 节）：明细和税额怎么算、抬头校验、发票号码。纯函数，不连库。

const item = (id: number, lineTotalFen: number, extra: Partial<Parameters<typeof buildInvoiceLines>[0][number]> = {}) => ({ salesOrderItemId: id, name: `商品${id}`, spec: null, qty: 1, returnedQty: 0, lineTotalFen, isService: false, ...extra });

describe("发票：明细和税额", () => {
  it("税额 = 含税金额 × 税率 ÷（1 + 税率），四舍五入到分", () => {
    expect(taxOf(325383, 1300)).toBe(37433);
    expect(taxOf(6417, 600)).toBe(363);
    expect(taxOf(0, 1300)).toBe(0);
  });

  it("整单优惠按成交额分摊，尾差给最后一行，合计正好等于应收；服务 6%、商品 13%", () => {
    const lines = buildInvoiceLines([item(1, 349900), item(2, 6900, { isService: true })], { subtotalFen: 356800, totalFen: 331800 });
    expect(lines.map((l) => [l.salesOrderItemId, l.amountFen, l.taxRateBp])).toEqual([[1, 325383, 1300], [2, 6417, 600]]);
    expect(lines.reduce((s, l) => s + l.amountFen, 0)).toBe(331800);
  });

  it("退了的件不开；配件按剩下的件数折算；金额是 0 的行不开", () => {
    const lines = buildInvoiceLines([item(1, 499900, { returnedQty: 1 }), item(2, 15000, { qty: 3 }), item(3, 0)], { subtotalFen: 514900, totalFen: 514900 });
    expect(lines.map((l) => [l.salesOrderItemId, l.qty, l.amountFen])).toEqual([[2, 3, 15000]]);
    const partial = buildInvoiceLines([item(2, 15000, { qty: 3, returnedQty: 1 })], { subtotalFen: 15000, totalFen: 15000 });
    expect(partial.map((l) => [l.qty, l.amountFen])).toEqual([[2, 10000]]);
    expect(buildInvoiceLines([], { subtotalFen: 0, totalFen: 0 })).toEqual([]);
  });
});

describe("发票：抬头", () => {
  it("个人只要抬头；企业要税号；专票只能开给企业、还要地址电话和开户行", () => {
    expect(validateInvoiceTitle({ kind: "E_NORMAL", titleType: "PERSONAL", titleName: " 张三 ", buyerTaxNo: "91440300MA5DEMXX1U" })).toMatchObject({ titleName: "张三", buyerTaxNo: null });
    expect(() => validateInvoiceTitle({ kind: "E_NORMAL", titleType: "COMPANY", titleName: "某公司" })).toThrow("纳税人识别号");
    expect(() => validateInvoiceTitle({ kind: "E_NORMAL", titleType: "COMPANY", titleName: "某公司", buyerTaxNo: "123" })).toThrow("15～20 位");
    expect(() => validateInvoiceTitle({ kind: "E_SPECIAL", titleType: "PERSONAL", titleName: "张三" })).toThrow("专票只能开给企业");
    expect(() => validateInvoiceTitle({ kind: "E_SPECIAL", titleType: "COMPANY", titleName: "某公司", buyerTaxNo: "91440300ma5demxx1u" })).toThrow("地址电话");
    expect(validateInvoiceTitle({ kind: "E_SPECIAL", titleType: "COMPANY", titleName: "某公司", buyerTaxNo: "91440300ma5demxx1u", buyerAddressPhone: "深圳 0755-1", buyerBankAccount: "招行 1" })).toMatchObject({ buyerTaxNo: "91440300MA5DEMXX1U" });
    expect(() => validateInvoiceTitle({ kind: "XX", titleType: "PERSONAL", titleName: "张三" })).toThrow(InvoiceRuleError);
  });

  it("纳税人识别号：18 位按统一社会信用代码查（没有 I、O、Z、S、V，最后一位是校验码）；其他位数的老号码只查字母数字", () => {
    expect(usccCheckChar("91440300MA5DEMXX1")).toBe("U");
    expect(usccCheckChar("9144030OIZSV00001")).toBeNull();
    expect(taxNoProblem("91440300MA5DEMXX1U")).toBeNull();
    expect(taxNoProblem("91440300MA5DEMXX1A")).toContain("校验码");
    expect(taxNoProblem("9144030OIZSV00001X")).toContain("I、O、Z、S、V");
    expect(taxNoProblem("440300123456789")).toBeNull(); // 15 位老税务登记号
    expect(taxNoProblem("44030019900101123X01")).toBeNull(); // 20 位
    expect(taxNoProblem("12345")).toContain("15～20 位");
    expect(() => validateInvoiceTitle({ kind: "E_NORMAL", titleType: "COMPANY", titleName: "某公司", buyerTaxNo: "9144030oizsv00001x" })).toThrow("统一社会信用代码不对");
  });

  it("电子票接收方是邮箱或手机，纸质票不要接收方", () => {
    expect(validateInvoiceTitle({ kind: "E_NORMAL", titleType: "PERSONAL", titleName: "张三", receiver: "a@b.cn" }).receiver).toBe("a@b.cn");
    expect(() => validateInvoiceTitle({ kind: "E_NORMAL", titleType: "PERSONAL", titleName: "张三", receiver: "随便" })).toThrow("邮箱或 11 位手机号");
    expect(validateInvoiceTitle({ kind: "PAPER_NORMAL", titleType: "PERSONAL", titleName: "张三", receiver: "13800138000" }).receiver).toBeNull();
  });
});

describe("发票号码", () => {
  it("登记时去掉空格横线，8～20 位数字；模拟的数电票号码 20 位", () => {
    expect(normalizeInvoiceNumber(" 2644 1020-0000 0000 0001 ")).toBe("26441020000000000001");
    expect(normalizeInvoiceNumber("1234567")).toBeNull();
    expect(normalizeInvoiceNumber("ABCDEFGH")).toBeNull();
    const n = simulateInvoiceNumber(1, new Date("2026-10-20T00:00:00.000Z"));
    expect(n).toBe("26441020000000000001");
    expect(n).toHaveLength(20);
  });
});
