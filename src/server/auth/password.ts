import bcrypt from "bcryptjs";

// 密码只存 bcrypt 哈希。10 轮在本机约 60 毫秒一次，演示版够用。
const ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
