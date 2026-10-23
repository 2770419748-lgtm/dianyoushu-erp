import { describe, expect, it } from "vitest";
import writeXlsxFile from "write-excel-file/node";
import { decodeText, looksLikeScientific, MAX_IMPORT_ROWS, parseCsv, positiveInt, TableError, toRecords, yuanToFen } from "@/lib/import/table";
import { DEVICE_COLUMNS, nameKey, skuDisplayName } from "@/lib/import/specs";
import { readUpload, safeRezip } from "@/server/import/read-file";
import { unzipSync, zipSync } from "fflate";
import { templateXlsx } from "@/server/import/templates";

// 数据导入的表格读取（口径第 22 节）：CSV 的编码和拆分、表头认列、格子格式，.xlsx 模板写出去再读回来。

describe("CSV", () => {
  it("UTF-8（带不带 BOM）和 Excel 中文版另存的 GBK 都认", () => {
    expect(decodeText(new TextEncoder().encode("﻿门店编码,数量"))).toBe("门店编码,数量");
    // “门店编码”的 GBK 编码
    expect(decodeText(new Uint8Array([0xc3, 0xc5, 0xb5, 0xea, 0xb1, 0xe0, 0xc2, 0xeb]))).toBe("门店编码");
  });

  it("引号里的逗号、换行、双引号；行号按文件里的行算", () => {
    const rows = parseCsv('a,b\r\n"x,1","第一行\n第二行"\n\n"说""好""",3');
    expect(rows).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["x,1", "第一行\n第二行"] },
      { line: 4, cells: [""] },
      { line: 5, cells: ['说"好"', "3"] },
    ]);
    expect(() => parseCsv('a\n"没配对')).toThrow(TableError);
  });

  it("表头按列名认、顺序不限、认别名和“（元）”“*”；空行跳过；缺必填列报出来", () => {
    const rows = parseCsv("成本（元）,串号,门店编码*,不认识的列\nS1,860000000000001,S001,x\n,,,\n4900,860000000000002,S002,");
    const recs = toRecords(rows, DEVICE_COLUMNS);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ line: 2, values: { cost: "S1", imei1: "860000000000001", storeCode: "S001", sn: "" } });
    expect(recs[1]!.line).toBe(4);
    expect(() => toRecords(parseCsv("门店编码,IMEI1\nS001,1"), DEVICE_COLUMNS)).toThrow(/成本/);
    expect(() => toRecords(parseCsv("门店编码,成本\n"), DEVICE_COLUMNS)).toThrow(/没有数据/);
    expect(() => toRecords([], DEVICE_COLUMNS)).toThrow(/空的/);
  });

  it("一个文件最多 5000 行", () => {
    const rows = [{ line: 1, cells: ["门店编码", "成本"] }, ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ line: i + 2, cells: ["S001", "1"] }))];
    expect(() => toRecords(rows, DEVICE_COLUMNS)).toThrow(/5000/);
  });
});

describe("格子格式", () => {
  it("金额：元转分，最多两位小数，带千分位和人民币符号也认", () => {
    expect(yuanToFen("4,999.5")).toBe(499950);
    expect(yuanToFen("¥ 29")).toBe(2900);
    expect(yuanToFen("")).toBeNull();
    expect(yuanToFen("12.345")).toBeNaN();
    expect(yuanToFen("-5")).toBeNaN();
  });

  it("数量要正整数；Excel 的科学计数法认得出来", () => {
    expect(positiveInt("20")).toBe(20);
    expect(positiveInt("0")).toBeNaN();
    expect(positiveInt("1.5")).toBeNaN();
    expect(positiveInt("")).toBeNull();
    expect(looksLikeScientific("8.6E+14")).toBe(true);
    expect(looksLikeScientific("8.60000000000001e14")).toBe(true);
    expect(looksLikeScientific("860000000000001")).toBe(false);
  });

  it("商品名和按名字认商品的键", () => {
    expect(skuDisplayName("Mate 70", "12GB+256GB", "曜金黑")).toBe("Mate 70 12GB+256GB 曜金黑");
    expect(skuDisplayName("钢化膜（高清）", null, "")).toBe("钢化膜（高清）");
    expect(nameKey("苹果", "iPhone 16 Pro", "黑色钛金属", "256GB")).toBe(nameKey("苹果", "iphone16pro", "黑色钛金属", "256gb"));
  });
});

describe(".xlsx", () => {
  it("模板：表头带 * 标必填，读回来认得出；码列设成文本，数字原样读成文字不走样", async () => {
    const template = await templateXlsx("DEVICES");
    const rows = await readUpload(new Uint8Array(template), "模板.xlsx");
    expect(rows[0]!.cells).toContain("门店编码*");
    expect(() => toRecords(rows, DEVICE_COLUMNS)).toThrow(/没有数据/); // 模板里没有示例行，不会被当成数据导进去
    const filled = await writeXlsxFile([
      ["门店编码", "IMEI1", "成本"],
      ["S001", 860000000000001, 4900.5],
      [null, null, null],
      ["S002", { type: String, value: "860000000000002", format: "@" }, 5000],
    ]).toBuffer();
    const recs = toRecords(await readUpload(new Uint8Array(filled), "机器.xlsx"), DEVICE_COLUMNS);
    expect(recs.map((r) => [r.line, r.values.imei1, r.values.cost])).toEqual([
      [2, "860000000000001", "4900.5"],
      [4, "860000000000002", "5000"],
    ]);
  });

  it("老的 .xls、空文件、坏文件给明白提示", async () => {
    await expect(readUpload(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), "旧.xls")).rejects.toThrow(/另存为/);
    await expect(readUpload(new Uint8Array(), "空.xlsx")).rejects.toThrow(/空的/);
    await expect(readUpload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "坏.xlsx")).rejects.toThrow(/打不开|读不出/);
  });

  it("压缩炸弹：单个、总量、个数超上限拒绝；目录里写小了解到写的大小马上停（复查第 75、79 条）", () => {
    const limits = { maxEntries: 3, maxEntryBytes: 1024, maxTotalBytes: 1500 };
    expect(() => safeRezip(zipSync({ a: new Uint8Array(2000) }), limits)).toThrow(/太大/);
    expect(() => safeRezip(zipSync({ a: new Uint8Array(800), b: new Uint8Array(800) }), limits)).toThrow(/太大/);
    expect(() => safeRezip(zipSync({ a: new Uint8Array(1), b: new Uint8Array(1), c: new Uint8Array(1), d: new Uint8Array(1) }), limits)).toThrow(/太多/);
    // 正常的文件原样过：解开、重新打包，内容一样
    const ok = unzipSync(safeRezip(zipSync({ "x/a.xml": new TextEncoder().encode("<a/>"), b: new Uint8Array(500).fill(7) }), limits));
    expect(new TextDecoder().decode(ok["x/a.xml"])).toBe("<a/>");
    expect(ok.b!.every((v) => v === 7)).toBe(true);
    // 做一个“目录里写 100 字节、实际能解出 20 MB”的文件：解到 100 字节就报错停下，不会把 20 MB 都解一遍
    const zip = zipSync({ a: new Uint8Array(20 * 1024 * 1024) });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let cd = zip.length - 22;
    while (view.getUint32(cd, true) !== 0x06054b50) cd--;
    const dir = view.getUint32(cd + 16, true);
    view.setUint32(dir + 24, 100, true); // 中央目录里的“解开后大小”
    const started = performance.now();
    expect(() => safeRezip(zip, { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 1000 })).toThrow(/对不上/);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
