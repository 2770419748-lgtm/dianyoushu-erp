import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

// 企业微信回调的验签和加解密（官方“加解密方案”）。只用 Node 自带的 crypto，不加新依赖；纯函数，单元测试用官方示例向量。
// - 签名 = sha1(把 Token、timestamp、nonce、密文 四个字符串按字典序排好后拼起来)
// - 密钥 = Base64(EncodingAESKey + "=")，32 字节；AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 按 32 字节补位
// - 明文 = 16 字节随机串 + 4 字节消息长度（网络字节序）+ 消息 + receiveid（企业 ID），解密后要核对 receiveid

export class WecomCryptoError extends Error {}

const BLOCK = 32;

export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}

/** 比对签名用定长比较，不给按字节试的机会 */
export function verifyWecomSignature(signature: string, token: string, timestamp: string, nonce: string, encrypt: string): boolean {
  const expected = Buffer.from(wecomSignature(token, timestamp, nonce, encrypt));
  const given = Buffer.from(signature.toLowerCase());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * 侧边栏 JS-SDK 的 agentConfig 签名：sha1("jsapi_ticket=…&noncestr=…&timestamp=…&url=…")，
 * url 是当前页面的完整地址（不含 # 后面的部分），参数名全小写、按这个顺序拼
 */
export function agentConfigSignature(ticket: string, nonceStr: string, timestamp: number, url: string): string {
  const cleanUrl = url.split("#")[0]!;
  return createHash("sha1").update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${cleanUrl}`).digest("hex");
}

export function isValidAesKey(aesKey: string): boolean {
  return /^[A-Za-z0-9+/]{43}$/.test(aesKey) && Buffer.from(`${aesKey}=`, "base64").length === 32;
}

function keyBytes(aesKey: string): Buffer {
  if (!isValidAesKey(aesKey)) throw new WecomCryptoError("EncodingAESKey 格式不对：应该是 43 位字母数字");
  return Buffer.from(`${aesKey}=`, "base64");
}

export function decryptWecomMessage(aesKey: string, encrypted: string, expectedReceiveId: string): string {
  const key = keyBytes(aesKey);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
  } catch {
    throw new WecomCryptoError("解密失败：密文被改过或 EncodingAESKey 不对");
  }
  const pad = plain[plain.length - 1] ?? 0;
  if (pad < 1 || pad > BLOCK || plain.length < 20 + pad) throw new WecomCryptoError("解密失败：补位不对");
  const body = plain.subarray(0, plain.length - pad);
  const length = body.readUInt32BE(16);
  if (20 + length > body.length) throw new WecomCryptoError("解密失败：消息长度不对");
  const message = body.subarray(20, 20 + length).toString("utf8");
  const receiveId = body.subarray(20 + length).toString("utf8");
  if (receiveId !== expectedReceiveId) throw new WecomCryptoError("解密后企业 ID 对不上：这条消息不是发给本企业的");
  return message;
}

/** 加密（模拟器造事件、单元测试用；被动回复消息时也是这个格式） */
export function encryptWecomMessage(aesKey: string, message: string, receiveId: string, random: Buffer = randomBytes(16)): string {
  const key = keyBytes(aesKey);
  const msg = Buffer.from(message, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(msg.length);
  const raw = Buffer.concat([random, length, msg, Buffer.from(receiveId, "utf8")]);
  const pad = BLOCK - (raw.length % BLOCK);
  const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

/** 回调去重键：解密后整段明文的 sha256（企业微信超时重试时发的是同一段明文） */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
