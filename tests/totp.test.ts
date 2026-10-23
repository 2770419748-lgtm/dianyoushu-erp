import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpAt, verifyTotp } from "@/server/auth/totp";

// 二次验证的动态码（口径第 20 节）：用 RFC 6238 附录 B 的测试向量核对算法，再核对时间窗、防重放。

// RFC 6238 的 SHA1 测试密钥是 ASCII "12345678901234567890"
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("和 RFC 6238 的测试向量一致（8 位码取后 6 位）", () => {
    // T=59 → 94287082，T=1111111109 → 07081804，T=1234567890 → 89005924
    expect(totpAt(RFC_SECRET, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(totpAt(RFC_SECRET, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(totpAt(RFC_SECRET, Math.floor(1234567890 / 30), 8)).toBe("89005924");
    expect(totpAt(RFC_SECRET, Math.floor(59 / 30))).toBe("287082");
  });

  it("base32 编码来回一致；新密钥是 32 个 base32 字符", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });

  it("前后各差一个时间窗也认；差两个不认；格式不对不认", () => {
    const now = new Date(1_800_000_000_000);
    const step = Math.floor(now.getTime() / 30000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeNull();
  });

  it("用过的时间窗不能再用（防止旁边有人看到再输一次）", () => {
    const now = new Date(1_800_000_000_000);
    const step = Math.floor(now.getTime() / 30000);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it("二维码内容：标准 otpauth 地址", () => {
    expect(otpauthUri("JBSWY3DPEHPK3PXP", "hq")).toBe("otpauth://totp/%E5%BA%97%E6%9C%89%E6%95%B0ERP%3Ahq?secret=JBSWY3DPEHPK3PXP&issuer=%E5%BA%97%E6%9C%89%E6%95%B0ERP&algorithm=SHA1&digits=6&period=30");
  });
});
