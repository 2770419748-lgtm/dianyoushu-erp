import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// 二次验证的动态码（口径第 20 节）：标准 TOTP（RFC 6238），HMAC-SHA1、6 位、30 秒一换，
// 手机上的验证器 App（Google Authenticator、Microsoft Authenticator、腾讯身份验证器等）都认。
// 纯函数，方便用 RFC 里的测试向量测。

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1; // 允许前后各差一个时间窗（手机时间不太准也能用）

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("密钥格式不对");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新的密钥：20 字节随机数，base32（验证器 App 手动输入时用的就是这串） */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 某个时间窗的动态码 */
export function totpAt(secret: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * 核对动态码：对上了返回是哪个时间窗（调用方记下来，同一个窗的码不能再用），对不上返回 null。
 * lastStep 是上次用过的时间窗：不大于它的码一律不认（防止被人在旁边看到再用一次）。
 */
export function verifyTotp(secret: string, code: string, now: Date, lastStep: number | null = null): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const current = totpStep(now);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = current + delta;
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

/** 验证器 App 扫的二维码里的内容 */
export function otpauthUri(secret: string, account: string, issuer = "店有数ERP"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
