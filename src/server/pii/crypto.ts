import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { maskPhone } from "@/lib/sales-labels";

// 个人信息加密（口径第 20 节）：手机号、身份证号这类在数据库和备份里不存明文，每个值存三样：
// - 密文：AES-256-GCM（DATA_ENCRYPTION_KEY），要看完整号码时在服务端解开；
// - 指纹：HMAC-SHA256（DATA_INDEX_KEY），同一个号码指纹一样，用来整号查找、判重（唯一约束建在指纹上）；
// - 打码号码：前 3 后 4（138****1234），页面本来就只显示这个，尾号搜索也用它。
// 密文带版本号 v1，以后换密钥时加 v2、跑重加密脚本。
// 没有 "server-only" 标记：prisma/ 下的演示数据脚本也要用；页面组件不要引用这个文件（里面用到 node:crypto 和密钥）。

const VERSION = "v1";

// 只给本机开发和自动测试用的固定密钥（NODE_ENV 是 development 或 test 时才会用到）。生产环境必须在 .env 里配自己的。
export const DEV_DATA_KEYS = {
  DATA_ENCRYPTION_KEY: "+mrWWYKQtIiQW76PKlbB3wfQztJldVkvibecdn4h1UU=",
  DATA_INDEX_KEY: "Hc09tXFslajqWZ1wTxulCMVqqiyi43/LA5AG3SnLwYs=",
} as const;

type KeyName = keyof typeof DEV_DATA_KEYS;

/** 环境变量里的密钥：32 字节的 base64；不合格返回 null */
export function decodeDataKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const buf = Buffer.from(value, "base64");
  return buf.length === 32 && buf.toString("base64") === value.trim() ? buf : null;
}

const cache = new Map<KeyName, Buffer>();

function key(name: KeyName): Buffer {
  const hit = cache.get(name);
  if (hit) return hit;
  const raw = process.env[name];
  let buf = decodeDataKey(raw);
  if (raw && !buf) throw new Error(`${name} 格式不对：要 32 字节的 base64（node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" 生成）`);
  if (!buf) {
    const env = process.env.NODE_ENV;
    if (env !== "development" && env !== "test") throw new Error(`缺少环境变量 ${name}（个人信息加密用，见 docs/部署.md）`);
    buf = Buffer.from(DEV_DATA_KEYS[name], "base64");
  }
  cache.set(name, buf);
  return buf;
}

/** 加密：v1.iv.tag.密文（都是 base64url） */
export function encryptPii(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("DATA_ENCRYPTION_KEY"), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** 解密；密文被改过或密钥不对会报错（GCM 自带校验） */
export function decryptPii(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined) throw new Error("个人信息密文格式不对");
  const decipher = createDecipheriv("aes-256-gcm", key("DATA_ENCRYPTION_KEY"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** 指纹：同一类、同一个值算出来一样；不同类（手机号、身份证号）分开，免得撞在一起 */
export function piiFingerprint(kind: "phone" | "idcard" | "check", value: string): string {
  return createHmac("sha256", key("DATA_INDEX_KEY")).update(`${kind}:${value}`).digest("base64url");
}

/** 身份证号打码：前 3 后 4，中间全是 *（110***********1234） */
export function maskIdCard(id: string): string {
  return id.length > 7 ? `${id.slice(0, 3)}${"*".repeat(id.length - 7)}${id.slice(-4)}` : id;
}

/** 存手机号要写的三列（列名和 schema 里的一致） */
export function phoneColumns(phone: string): { phoneEnc: string; phoneFp: string; phoneMasked: string } {
  return { phoneEnc: encryptPii(phone), phoneFp: piiFingerprint("phone", phone), phoneMasked: maskPhone(phone) };
}

/** 手机号指纹（整号查找用） */
export function phoneFingerprint(phone: string): string {
  return piiFingerprint("phone", phone);
}

/**
 * 按手机号搜的条件（口径第 20 节）：完整 11 位按指纹精确查；4 位数字按尾号（打码号码的后 4 位）查；别的不按号码查。
 * 返回 null 表示这段文字不当号码搜。
 */
export function phoneSearch(text: string): { phoneFp: string } | { phoneMasked: { endsWith: string } } | null {
  if (/^1\d{10}$/.test(text)) return { phoneFp: phoneFingerprint(text) };
  if (/^\d{4}$/.test(text)) return { phoneMasked: { endsWith: text } };
  return null;
}
