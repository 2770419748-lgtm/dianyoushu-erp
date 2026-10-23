import "dotenv/config";
import { randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { addDays, TRIAL_DAYS } from "@/lib/license";
import { bjDateKey } from "@/lib/attendance";
import { writeAudit } from "@/server/audit";
import { hashPassword } from "@/server/auth/password";
import { assertDataKeys } from "@/server/pii/key-check";
import { setLicense } from "@/server/settings/settings-service";
import { seedBaseline } from "../prisma/seed-data/products";

// 开户（口径第 21 节）：一家新客户的空库上跑一次。
// 用法（服务器上，这家客户的 tools 容器里）：pnpm tenant:init --name "某某通讯" [--admin admin] [--trial-days 30]
// 做的事：写公司名；建基础数据（品类、默认碎屏险延保、回收用的“其他机型”）；建总部管理员（随机初始密码只打印这一次，
// 第一次登录先改密码、再绑二次验证）；开试用。不灌演示数据。只能在真用模式（DEMO_MODE=0）、空库（没有门店和员工）上跑。

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 12 位初始密码：去掉容易看错的 0 O 1 l I */
function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[randomInt(chars.length)]).join("");
}

async function main() {
  const name = arg("name")?.trim();
  const admin = (arg("admin") ?? "admin").trim().toLowerCase();
  const trialDays = Number(arg("trial-days") ?? TRIAL_DAYS);
  if (!name) throw new Error('要写公司名：pnpm tenant:init --name "某某通讯"');
  if (name.length > 40) throw new Error("公司名最多 40 个字");
  if (!/^[a-z0-9_]{3,30}$/.test(admin)) throw new Error("管理员账号只能用小写字母、数字、下划线，3 到 30 位");
  if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 365) throw new Error("试用天数 1～365");
  if (process.env.DEMO_MODE !== "0") throw new Error("开户只在真用模式跑：.env 里写 DEMO_MODE=0（演示站用 pnpm db:reset）");
  const [stores, users] = await Promise.all([prisma.store.count(), prisma.user.count()]);
  if (stores > 0 || users > 0) throw new Error(`这个库已经有 ${stores} 家门店、${users} 个员工，开户只能在空库上跑`);

  await assertDataKeys(prisma, "开户"); // 空库：记下这套个人信息钥匙
  const base = await seedBaseline(prisma);
  const today = bjDateKey(new Date());
  const license = { plan: "TRIAL" as const, startedOn: today, expiresOn: addDays(today, trialDays), storeLimit: null };
  const password = randomPassword();
  await prisma.$transaction(async (tx) => {
    await tx.systemSetting.create({ data: { key: "company", value: { name, receiptTitle: name, phone: null, address: null } } });
    await setLicense(license, tx);
    const user = await tx.user.create({ data: { username: admin, name: "管理员", role: "HQ", passwordHash: await hashPassword(password), mustChangePassword: true } });
    await writeAudit({ userId: null, action: "tenant.init", entity: "user", entityId: user.id, detail: { company: name, admin, trialDays, expiresOn: license.expiresOn, by: "服务器脚本" } }, tx);
  });

  console.log(`开户完成：${name}`);
  console.log(`  基础数据：品类 4 个、服务商品和回收用的“其他机型”共 ${base.skus} 个`);
  console.log(`  试用 ${trialDays} 天，到期日 ${license.expiresOn}（到期后 15 天照常用，之后只读）`);
  console.log(`  总部管理员：账号 ${admin}，初始密码 ${password}`);
  console.log("  这个初始密码只显示这一次：交给客户，第一次登录先改密码、再绑手机验证器，然后进“系统设置”做初始化。");
}

main()
  .catch((error) => {
    console.error(`开户失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
