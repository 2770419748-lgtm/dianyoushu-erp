import { describe, expect, it } from "vitest";
import { csvCell, exportCell, toCsv } from "@/lib/csv";

// CSV 导出：防 Excel 公式注入，同时不破坏金额（负数照样是数字）。
describe("csvCell", () => {
  it("以 = + - @ 开头的文字前面加单引号，Excel 不会当公式执行", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-店名")).toBe("'-店名");
  });

  it("金额和普通文字不动", () => {
    expect(csvCell("-29.00")).toBe("-29.00");
    expect(csvCell("4857.00")).toBe("4857.00");
    expect(csvCell(12)).toBe("12");
    expect(csvCell("S001 中山路店")).toBe("S001 中山路店");
  });

  it("逗号、引号、换行要加引号包起来", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('说"好"')).toBe('"说""好"""');
  });

  it("整表带 BOM、Windows 换行", () => {
    expect(toCsv([["门店", "金额"], ["S001", "-29.00"]])).toBe("﻿门店,金额\r\nS001,-29.00\r\n");
  });
});

describe("exportCell（整库导出）", () => {
  it("12 位以上的纯数字前面加单引号，Excel 不会丢位、不会变成科学计数法（复查第 71 条）", () => {
    expect(exportCell("11010519491231002X")).toBe("11010519491231002X"); // 带 X 的 Excel 本来就当文字
    expect(exportCell("110105194912310021")).toBe("'110105194912310021");
    expect(exportCell("860000000000001")).toBe("'860000000000001");
    expect(exportCell("13800000000")).toBe("13800000000"); // 11 位手机号 Excel 能完整显示
    expect(exportCell("499900")).toBe("499900");
  });

  it("公式防护照旧；空值写成空格子", () => {
    expect(exportCell("=1+1")).toBe("'=1+1");
    expect(exportCell("-12")).toBe("-12");
    expect(exportCell(null)).toBe("");
  });
});
