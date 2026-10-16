import { describe, expect, it } from "vitest";
import { isValidCode, isValidImei, isValidSn, parseCodeList, parseDeviceCodeLines, primaryCode } from "@/server/stock/imei";

describe("机器编码格式", () => {
  it("IMEI 要 15 位数字", () => {
    expect(isValidImei("867530012345678")).toBe(true);
    expect(isValidImei("86753001234567")).toBe(false);
    expect(isValidImei("86753001234567A")).toBe(false);
  });

  it("SN 是 6 到 30 位字母数字横线，且不能长得像 IMEI", () => {
    expect(isValidSn("SN8F2K1X9Q")).toBe(true);
    expect(isValidSn("ab-12")).toBe(false);
    expect(isValidSn("867530012345678")).toBe(false);
    expect(isValidCode("SN8F2K1X9Q")).toBe(true);
    expect(isValidCode("867530012345678")).toBe(true);
  });

  it("主码：有 IMEI1 用 IMEI1，否则 SN，否则 IMEI2", () => {
    expect(primaryCode({ sn: "SNA", imei1: "867530012345678", imei2: null })).toBe("867530012345678");
    expect(primaryCode({ sn: "SNABCDEF", imei1: null, imei2: "867530012345679" })).toBe("SNABCDEF");
    expect(primaryCode({ sn: null, imei1: null, imei2: "867530012345679" })).toBe("867530012345679");
    expect(primaryCode({ sn: null, imei1: null, imei2: null })).toBeNull();
  });
});

describe("一批单个码（盘点实盘、调拨收货）", () => {
  it("换行、空格、逗号、分号都能分开，并去重、挑出不合法的", () => {
    const result = parseCodeList("867530012345678\n867530012345679, SN8F2K1X9Q；867530012345678 ab");
    expect(result.valid).toEqual(["867530012345678", "867530012345679", "SN8F2K1X9Q"]);
    expect(result.duplicates).toEqual(["867530012345678"]);
    expect(result.invalid).toEqual(["ab"]);
  });
});

describe("入库粘贴：一行一台，每行 1 到 3 个码", () => {
  it("三个码齐全：15 位数字按顺序是 IMEI1、IMEI2，其他的是 SN", () => {
    const result = parseDeviceCodeLines("SN8F2K1X9Q 867530012345678 867530012345679");
    expect(result.errors).toEqual([]);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]).toMatchObject({ sn: "SN8F2K1X9Q", imei1: "867530012345678", imei2: "867530012345679", code: "867530012345678" });
  });

  it("顺序不限、Tab 和逗号也行；只有一个码也行", () => {
    const result = parseDeviceCodeLines("867530012345678\tSNABCDEF\n867530012345680,867530012345681\nSNONLY01");
    expect(result.errors).toEqual([]);
    expect(result.devices.map((d) => d.code)).toEqual(["867530012345678", "867530012345680", "SNONLY01"]);
    expect(result.devices[1]).toMatchObject({ sn: null, imei1: "867530012345680", imei2: "867530012345681" });
    expect(result.devices[2]).toMatchObject({ sn: "SNONLY01", imei1: null, imei2: null });
  });

  it("一行超过两个 IMEI 或两个 SN 报错，并带行号", () => {
    const result = parseDeviceCodeLines("867530012345678 867530012345679 867530012345680\nSNAAAAAA SNBBBBBB");
    expect(result.devices).toHaveLength(0);
    expect(result.errors[0]).toContain("第 1 行");
    expect(result.errors[1]).toContain("第 2 行");
  });

  it("不同行出现同一个码报重复", () => {
    const result = parseDeviceCodeLines("867530012345678\nSNXXXXXX 867530012345678");
    expect(result.devices).toHaveLength(1);
    expect(result.duplicates).toEqual(["867530012345678"]);
    expect(result.errors[0]).toContain("第 2 行");
  });

  it("格式不对的码报错", () => {
    const result = parseDeviceCodeLines("abc");
    expect(result.devices).toHaveLength(0);
    expect(result.errors[0]).toContain("既不是 15 位 IMEI");
  });
});
