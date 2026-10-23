import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { addDays, LICENSE_PLAN_LABELS, licenseState, type License, type LicensePlan } from "@/lib/license";
import { bjDateKey } from "@/lib/attendance";
import { writeAudit } from "@/server/audit";
import { getLicense, setLicense } from "@/server/settings/settings-service";

// 改开户信息（口径第 21 节）：续费、转正式、加门店数。只在服务器上跑（我们跑），记操作日志。
// 用法：
//   pnpm license:set                                   看现在的
//   pnpm license:set --plan PAID --expires 2027-12-31 --stores 10
//   pnpm license:set --days 30                         在现在的到期日上再加 30 天（过期了从今天起算）
//   pnpm license:set --stores none                     门店数不限

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function show(label: string, l: License | null) {
  if (!l) return console.log(`${label}：没有开户信息`);
  const state = licenseState(l, bjDateKey(new Date()), false).kind;
  console.log(`${label}：${LICENSE_PLAN_LABELS[l.plan]}，到期日 ${l.expiresOn}，门店数上限 ${l.storeLimit ?? "不限"}（现在：${state}）`);
}

async function main() {
  const before = await getLicense();
  const plan = arg("plan");
  const expires = arg("expires");
  const days = arg("days");
  const stores = arg("stores");
  if (!plan && !expires && !days && !stores) return show("现在", before);

  const today = bjDateKey(new Date());
  const base: License = before ?? { plan: "TRIAL", startedOn: today, expiresOn: today, storeLimit: null };
  const next: License = { ...base };
  if (plan) {
    if (plan !== "TRIAL" && plan !== "PAID") throw new Error("--plan 只能是 TRIAL（试用）或 PAID（正式）");
    if (plan !== base.plan) next.startedOn = today;
    next.plan = plan as LicensePlan;
  }
  if (expires) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) throw new Error("--expires 要写成 2027-12-31");
    next.expiresOn = expires;
  }
  if (days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 3660) throw new Error("--days 1～3660");
    next.expiresOn = addDays(base.expiresOn >= today ? base.expiresOn : today, n);
  }
  if (stores) {
    if (stores === "none") next.storeLimit = null;
    else {
      const n = Number(stores);
      if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error("--stores 写门店数（1 以上），不限写 none");
      next.storeLimit = n;
    }
  }
  await setLicense(next);
  await writeAudit({ userId: null, action: "license.set", detail: { before, after: next, by: "服务器脚本" } as never });
  show("改之前", before);
  show("改之后", next);
}

main()
  .catch((error) => {
    console.error(`改开户信息失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
