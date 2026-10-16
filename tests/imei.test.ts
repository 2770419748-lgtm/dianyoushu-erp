import { describe, expect, it } from "vitest";
import { isValidImei, parseImeiList } from "@/server/stock/imei";

describe("串号校验", () => {
  it("只有 15 位数字才合法", () => {
    expect(isValidImei("867530012345678")).toBe(true);
    expect(isValidImei("86753001234567")).toBe(false); // 14 位
    expect(isValidImei("8675300123456789")).toBe(false); // 16 位
    expect(isValidImei("86753001234567A")).toBe(false); // 有字母
  });

  it("一批粘贴：换行、空格、逗号、分号都能分开，并去重、挑出不合法的", () => {
    const text = "867530012345678\n867530012345679, 867530012345680；867530012345678 abc123";
    const result = parseImeiList(text);
    expect(result.valid).toEqual(["867530012345678", "867530012345679", "867530012345680"]);
    expect(result.duplicates).toEqual(["867530012345678"]);
    expect(result.invalid).toEqual(["abc123"]);
  });

  it("空文本什么都没有", () => {
    expect(parseImeiList("  \n ")).toEqual({ valid: [], invalid: [], duplicates: [] });
  });
});
