import "server-only";
import { prisma } from "@/lib/prisma";
import type { PaymentMethod } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { License } from "@/lib/license";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { asTx, type Db } from "@/server/db-tx";

// 系统设置（口径第 21 节）：一家一套部署的全局设置，存在 system_settings 表，一项一行。
// - company：公司名、小票抬头、电话、地址；
// - license：套餐、到期日、门店数上限（只在服务器上用 pnpm license:set 改）；
// - payment_methods：门店开单能选的收款方式；
// - switches：业务开关（回收登记身份证必填……）；
// - setup：初始化向导做完没有。

export class SettingsError extends Error {}

export interface Company {
  name: string;
  receiptTitle: string; // 小票抬头，默认等于公司名
  phone: string | null;
  address: string | null;
}

export interface Switches {
  tradeInIdRequired: boolean; // 回收登记卖家身份证必填（口径第 20 节，默认开）
}

/** 门店能手选的收款方式；以旧换新抵扣、国补立减是系统按单据生成的，不在这里 */
export const SELECTABLE_PAYMENT_METHODS: PaymentMethod[] = ["CASH", "WECHAT", "ALIPAY", "CARD", "INSTALLMENT", "OTHER"];
const DEFAULT_SWITCHES: Switches = { tradeInIdRequired: true };

async function read<T>(db: Db, key: string): Promise<T | null> {
  const row = await db.systemSetting.findUnique({ where: { key } });
  return row ? (row.value as T) : null;
}

async function write(db: Db, key: string, value: unknown): Promise<void> {
  await db.systemSetting.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue }, update: { value: value as Prisma.InputJsonValue } });
}

export async function getCompany(db: Db = prisma): Promise<Company | null> {
  return read<Company>(db, "company");
}

export async function getLicense(db: Db = prisma): Promise<License | null> {
  return read<License>(db, "license");
}

/** 只给开户、改套餐的服务器脚本用（不出页面） */
export async function setLicense(license: License, db: Db = prisma): Promise<void> {
  await write(db, "license", license);
}

export async function getPaymentMethods(db: Db = prisma): Promise<PaymentMethod[]> {
  const saved = await read<PaymentMethod[]>(db, "payment_methods");
  const list = (saved ?? SELECTABLE_PAYMENT_METHODS).filter((m) => SELECTABLE_PAYMENT_METHODS.includes(m));
  return list.length > 0 ? list : SELECTABLE_PAYMENT_METHODS;
}

export async function getSwitches(db: Db = prisma): Promise<Switches> {
  return { ...DEFAULT_SWITCHES, ...((await read<Partial<Switches>>(db, "switches")) ?? {}) };
}

export async function getSetupDone(db: Db = prisma): Promise<boolean> {
  return (await read<{ done?: boolean }>(db, "setup"))?.done === true;
}

function assertHq(user: CurrentUser) {
  if (user.role !== "HQ") throw new SettingsError("系统设置只有总部能改");
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 公司信息和小票抬头 */
export async function saveCompany(user: CurrentUser, input: { name: unknown; receiptTitle?: unknown; phone?: unknown; address?: unknown }, db: Db = prisma): Promise<void> {
  assertHq(user);
  const name = text(input.name, 40);
  if (!name) throw new SettingsError("填一下公司名");
  const phone = text(input.phone, 30) || null;
  if (phone && !/^[\d\-+() ]{5,30}$/.test(phone)) throw new SettingsError("电话只能有数字、横杠、括号、空格");
  const company: Company = { name, receiptTitle: text(input.receiptTitle, 40) || name, phone, address: text(input.address, 100) || null };
  await write(db, "company", company);
  await writeAudit({ userId: user.id, action: "settings.company", detail: { name: company.name, receiptTitle: company.receiptTitle } }, asTx(db));
}

/** 门店开单能选的收款方式，至少留一种 */
export async function savePaymentMethods(user: CurrentUser, methods: unknown, db: Db = prisma): Promise<void> {
  assertHq(user);
  const list = Array.isArray(methods) ? SELECTABLE_PAYMENT_METHODS.filter((m) => methods.includes(m)) : [];
  if (list.length === 0) throw new SettingsError("至少留一种收款方式");
  await write(db, "payment_methods", list);
  await writeAudit({ userId: user.id, action: "settings.payment_methods", detail: { methods: list } }, asTx(db));
}

export async function saveSwitches(user: CurrentUser, input: Partial<Record<keyof Switches, unknown>>, db: Db = prisma): Promise<void> {
  assertHq(user);
  const next: Switches = { ...(await getSwitches(db)) };
  if (typeof input.tradeInIdRequired === "boolean") next.tradeInIdRequired = input.tradeInIdRequired;
  await write(db, "switches", next);
  await writeAudit({ userId: user.id, action: "settings.switches", detail: { ...next } }, asTx(db));
}

export async function markSetupDone(user: CurrentUser, done: boolean, db: Db = prisma): Promise<void> {
  assertHq(user);
  if (done && !(await getCompany(db))) throw new SettingsError("先填公司信息");
  await write(db, "setup", { done });
  await writeAudit({ userId: user.id, action: "settings.setup", detail: { done } }, asTx(db));
}
