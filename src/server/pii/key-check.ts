import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { decryptPii, encryptPii, piiFingerprint } from "./crypto";

// 个人信息钥匙核对（口径第 20 节）：库里的手机号、身份证号是用哪两把钥匙写的，换服务器、恢复备份、抄错 .env 时
// 钥匙可能对不上——应用照常启动，但整号搜不到、同号码能重复建客户、解密的页面报错。所以：
// - 第一次写个人信息的程序（灌演示数据、应用第一次启动）在 system_settings 里存一条核对记录：一句固定的话的密文和指纹；
// - 应用启动、灌数据、每日任务开始前先核对：解得开、指纹一样才往下走，对不上直接停；
// - 老库（有客户、没有核对记录）解开一个客户的手机号、重算指纹比一比，对上了再补核对记录。
// 没有 "server-only" 标记：prisma/ 和 scripts/ 下的脚本也要用。

const SETTING_KEY = "data_key_check";
const PROBE = "店有数-个人信息钥匙核对-v1";

type Db = PrismaClient | Prisma.TransactionClient;

export type KeyCheckResult = { ok: true; created: boolean } | { ok: false; reason: string };

function matches(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const { enc, fp } = record as { enc?: unknown; fp?: unknown };
  if (typeof enc !== "string" || typeof fp !== "string") return false;
  try {
    return decryptPii(enc) === PROBE && fp === piiFingerprint("check", PROBE);
  } catch {
    return false;
  }
}

const MISMATCH = "DATA_ENCRYPTION_KEY / DATA_INDEX_KEY 和写这个库时用的不一样（换了服务器、恢复了别处的备份，或者 .env 抄错了）。要用原来那两把钥匙，对不上会导致手机号搜不到、能重复建客户、页面报错";

/** write=false（对账自检用）：没有核对记录时只核对、不补记录 */
export async function checkDataKeys(db: Db, options: { write?: boolean } = {}): Promise<KeyCheckResult> {
  const row = await db.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  if (row) return matches(row.value) ? { ok: true, created: false } : { ok: false, reason: MISMATCH };
  // 没有核对记录：老库先拿一个客户核对，新库直接记下现在的钥匙
  const sample = await db.customer.findFirst({ orderBy: { id: "asc" }, select: { phoneEnc: true, phoneFp: true } });
  if (sample) {
    let ok = false;
    try {
      ok = piiFingerprint("phone", decryptPii(sample.phoneEnc)) === sample.phoneFp;
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false, reason: MISMATCH };
  }
  if (options.write === false) return { ok: true, created: false };
  await db.systemSetting.createMany({ data: [{ key: SETTING_KEY, value: { enc: encryptPii(PROBE), fp: piiFingerprint("check", PROBE) } }], skipDuplicates: true });
  // 两个程序同时第一次启动：以先写进去的那条为准再核对一次
  const saved = await db.systemSetting.findUniqueOrThrow({ where: { key: SETTING_KEY } });
  return matches(saved.value) ? { ok: true, created: true } : { ok: false, reason: MISMATCH };
}

/** 脚本用：对不上就打印原因、退出 */
export async function assertDataKeys(db: Db, who: string): Promise<void> {
  const r = await checkDataKeys(db);
  if (!r.ok) {
    console.error(`[店有数 ERP] ${who}：个人信息钥匙对不上，停止。${r.reason}`);
    process.exit(1);
  }
}
