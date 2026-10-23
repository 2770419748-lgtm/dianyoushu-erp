import { describe, expect, it } from "vitest";
import { idCardCheckChar, isValidIdCard, normalizeIdCard } from "@/lib/id-card";
import { decodeDataKey, decryptPii, encryptPii, maskIdCard, phoneColumns, phoneSearch, piiFingerprint } from "@/server/pii/crypto";

// 个人信息加密（口径第 20 节）：手机号、身份证号存密文 + 指纹 + 打码号码。纯函数，不连库（测试环境用代码里的开发钥匙）。

describe("加密和指纹", () => {
  it("加密能解开；同一个号码每次密文不一样，改一个字就解不开", () => {
    const a = encryptPii("13800001111");
    const b = encryptPii("13800001111");
    expect(a).toMatch(/^v1\./);
    expect(a).not.toBe(b); // 每次随机 IV，库里看不出两个客户是不是同一个号
    expect(a).not.toContain("13800001111");
    expect(decryptPii(a)).toBe("13800001111");
    const parts = a.split(".");
    const body = parts[3]!;
    const tampered = [...parts.slice(0, 3), (body[0] === "A" ? "B" : "A") + body.slice(1)].join(".");
    expect(() => decryptPii(tampered)).toThrow();
    expect(() => decryptPii("13800001111")).toThrow("格式不对");
  });

  it("指纹：同类同值一样，不同值、不同类不一样", () => {
    expect(piiFingerprint("phone", "13800001111")).toBe(piiFingerprint("phone", "13800001111"));
    expect(piiFingerprint("phone", "13800001111")).not.toBe(piiFingerprint("phone", "13800001112"));
    expect(piiFingerprint("phone", "13800001111")).not.toBe(piiFingerprint("idcard", "13800001111"));
  });

  it("存手机号的三列：密文、指纹、前 3 后 4 的打码号码", () => {
    const c = phoneColumns("13912345678");
    expect(c.phoneMasked).toBe("139****5678");
    expect(c.phoneFp).toBe(piiFingerprint("phone", "13912345678"));
    expect(decryptPii(c.phoneEnc)).toBe("13912345678");
  });

  it("按号码搜：整号按指纹、4 位按尾号，别的位数不当号码搜", () => {
    expect(phoneSearch("13912345678")).toEqual({ phoneFp: piiFingerprint("phone", "13912345678") });
    expect(phoneSearch("5678")).toEqual({ phoneMasked: { endsWith: "5678" } });
    expect(phoneSearch("12345")).toBeNull(); // 中间几位搜不到
    expect(phoneSearch("1391234567")).toBeNull();
    expect(phoneSearch("张三")).toBeNull();
  });

  it("环境变量里的钥匙要是 32 字节的 base64", () => {
    expect(decodeDataKey("q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq4M=")).toHaveLength(32);
    expect(decodeDataKey("too-short")).toBeNull();
    expect(decodeDataKey(Buffer.alloc(16).toString("base64"))).toBeNull();
    expect(decodeDataKey(undefined)).toBeNull();
  });
});

describe("身份证号", () => {
  it("校验位、出生日期都要对；小写 x 和空格先规整", () => {
    expect(isValidIdCard("11010519491231002X")).toBe(true);
    expect(isValidIdCard(normalizeIdCard(" 11010519491231002x "))).toBe(true);
    expect(isValidIdCard("110105194912310021")).toBe(false); // 校验位错
    const feb30 = "11010519490230002";
    expect(isValidIdCard(feb30 + idCardCheckChar(feb30))).toBe(false); // 校验位对，日期不存在
    expect(isValidIdCard("1101051949123100")).toBe(false); // 位数不够
  });

  it("打码：前 3 后 4", () => {
    expect(maskIdCard("11010519491231002X")).toBe("110***********002X");
  });
});
