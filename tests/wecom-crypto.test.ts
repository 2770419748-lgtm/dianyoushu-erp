import { describe, expect, it } from "vitest";
import { decryptWecomMessage, encryptWecomMessage, isValidAesKey, verifyWecomSignature, wecomSignature, WecomCryptoError } from "@/server/wecom/crypto";
import { SIMULATED_CALLBACK, wecomMode } from "@/server/wecom/config";
import { buildWecomXml, parseWecomXml } from "@/server/wecom/xml";
import { OFFICIAL, OFFICIAL_POST, OFFICIAL_VERIFY_URL } from "./fixtures/wecom-official";

// 企业微信回调加解密（口径第 12 节），用官方示例向量（tests/fixtures/wecom-official.ts）。
const VERIFY_URL = OFFICIAL_VERIFY_URL;

describe("企业微信回调加解密（官方示例向量）", () => {
  it("URL 验证：签名对得上，解出官方给的 echostr 明文", () => {
    expect(wecomSignature(OFFICIAL.token, VERIFY_URL.timestamp, VERIFY_URL.nonce, VERIFY_URL.echostr)).toBe(VERIFY_URL.signature);
    expect(verifyWecomSignature(VERIFY_URL.signature, OFFICIAL.token, VERIFY_URL.timestamp, VERIFY_URL.nonce, VERIFY_URL.echostr)).toBe(true);
    expect(decryptWecomMessage(OFFICIAL.aesKey, VERIFY_URL.echostr, OFFICIAL.receiveId)).toBe("1616140317555161061");
  });

  it("消息：签名对得上，解出官方给的 XML", () => {
    expect(verifyWecomSignature(OFFICIAL_POST.signature, OFFICIAL.token, OFFICIAL_POST.timestamp, OFFICIAL_POST.nonce, OFFICIAL_POST.encrypt)).toBe(true);
    const fields = parseWecomXml(decryptWecomMessage(OFFICIAL.aesKey, OFFICIAL_POST.encrypt, OFFICIAL.receiveId));
    expect(fields).toMatchObject({ ToUserName: "wx5823bf96d3bd56c7", FromUserName: "mycreate", CreateTime: "1409659813", MsgType: "text", Content: "hello", AgentID: "218" });
  });

  it("签名错一位、换了参数都不认", () => {
    const bad = VERIFY_URL.signature.slice(0, -1) + (VERIFY_URL.signature.endsWith("3") ? "4" : "3");
    expect(verifyWecomSignature(bad, OFFICIAL.token, VERIFY_URL.timestamp, VERIFY_URL.nonce, VERIFY_URL.echostr)).toBe(false);
    expect(verifyWecomSignature(VERIFY_URL.signature, OFFICIAL.token, "1409659590", VERIFY_URL.nonce, VERIFY_URL.echostr)).toBe(false);
    expect(verifyWecomSignature("short", OFFICIAL.token, VERIFY_URL.timestamp, VERIFY_URL.nonce, VERIFY_URL.echostr)).toBe(false);
  });

  it("企业 ID 对不上、密文被改、密钥不对都解不出来", () => {
    expect(() => decryptWecomMessage(OFFICIAL.aesKey, VERIFY_URL.echostr, "ww-other")).toThrow(WecomCryptoError);
    const tampered = "A" + VERIFY_URL.echostr.slice(1);
    expect(() => decryptWecomMessage(OFFICIAL.aesKey, tampered, OFFICIAL.receiveId)).toThrow(WecomCryptoError);
    expect(() => decryptWecomMessage(SIMULATED_CALLBACK.aesKey, VERIFY_URL.echostr, OFFICIAL.receiveId)).toThrow(WecomCryptoError);
    expect(() => decryptWecomMessage("too-short", VERIFY_URL.echostr, OFFICIAL.receiveId)).toThrow(/43 位/);
  });

  it("自己加密再解密能还原（模拟器造事件用），中文和各种长度都行", () => {
    for (const message of ["", "a", "中文消息🙂", "x".repeat(31), "y".repeat(32), "z".repeat(1000)]) {
      const encrypted = encryptWecomMessage(SIMULATED_CALLBACK.aesKey, message, SIMULATED_CALLBACK.receiveId);
      expect(decryptWecomMessage(SIMULATED_CALLBACK.aesKey, encrypted, SIMULATED_CALLBACK.receiveId)).toBe(message);
    }
    // 固定随机串时，结果和官方 SDK 一样确定
    const fixed = Buffer.alloc(16, 1);
    expect(encryptWecomMessage(OFFICIAL.aesKey, "hi", OFFICIAL.receiveId, fixed)).toBe(encryptWecomMessage(OFFICIAL.aesKey, "hi", OFFICIAL.receiveId, fixed));
  });

  it("EncodingAESKey 格式检查", () => {
    expect(isValidAesKey(OFFICIAL.aesKey)).toBe(true);
    expect(isValidAesKey(SIMULATED_CALLBACK.aesKey)).toBe(true);
    expect(isValidAesKey(OFFICIAL.aesKey + "A")).toBe(false);
    expect(isValidAesKey("!".repeat(43))).toBe(false);
  });
});

describe("回调 XML 和对接模式", () => {
  it("取第一层字段，CDATA 和数字都认；拼出来能再解析回去", () => {
    const xml = buildWecomXml({ Event: "change_external_contact", CreateTime: 1700000000, State: "o2b3c]]>x" });
    expect(parseWecomXml(xml)).toEqual({ Event: "change_external_contact", CreateTime: "1700000000", State: "o2b3c]]>x" });
    expect(parseWecomXml("不是 xml")).toEqual({});
  });

  it("是否真调企业微信只看 WECOM_ENABLED；没开时演示模式是模拟，真用时关掉", () => {
    expect(wecomMode({ WECOM_ENABLED: "1", DEMO_MODE: "1" })).toBe("real");
    expect(wecomMode({ WECOM_ENABLED: "1", DEMO_MODE: "0" })).toBe("real");
    expect(wecomMode({ DEMO_MODE: "1" })).toBe("simulated");
    expect(wecomMode({})).toBe("simulated");
    expect(wecomMode({ WECOM_ENABLED: "0", DEMO_MODE: "0" })).toBe("off");
  });
});
