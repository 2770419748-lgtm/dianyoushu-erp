import { describe, expect, it } from "vitest";
import { appendScannedCode } from "@/lib/device/scanner";

// 入库、盘点连续扫码时，扫到的码追加进多行文本框：一行一个，重复的不加。
describe("appendScannedCode", () => {
  it("空框直接放进去，有内容就换行追加", () => {
    expect(appendScannedCode(undefined, "A1")).toBe("A1");
    expect(appendScannedCode("A1", "B2")).toBe("A1\nB2");
    expect(appendScannedCode("A1\n\n", "B2")).toBe("A1\nB2");
  });

  it("已经在框里的码（哪怕在同一行用空格隔开）不重复加", () => {
    expect(appendScannedCode("A1\nB2", "A1")).toBe("A1\nB2");
    expect(appendScannedCode("SN1 860000000000001", "860000000000001")).toBe("SN1 860000000000001");
  });
});
