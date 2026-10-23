import { NoAccess } from "@/components/no-access";
import { prisma } from "@/lib/prisma";
import { licenseState } from "@/lib/license";
import { bjDateKey } from "@/lib/attendance";
import { requireUser } from "@/server/auth/current-user";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { getCompany, getLicense, getPaymentMethods, getSetupDone, getSwitches, SELECTABLE_PAYMENT_METHODS } from "@/server/settings/settings-service";
import { SetupView } from "./setup-view";

export const dynamic = "force-dynamic";

// 系统设置 / 初始化向导（口径第 21 节）：一页清单，公司信息、收款方式、业务开关就在这里改；门店、员工、商品去对应的页面。
export default async function SetupPage() {
  const user = await requireUser();
  if (user.role !== "HQ") return <NoAccess subTitle="系统设置只有总部能改。" />;
  const [company, license, methods, switches, done, stores, users, products] = await Promise.all([
    getCompany(),
    getLicense(),
    getPaymentMethods(),
    getSwitches(),
    getSetupDone(),
    prisma.store.count({ where: { isActive: true } }),
    prisma.user.count({ where: { isActive: true, role: { not: "HQ" } } }),
    // 回收用的“其他机型”是开户时建的，不算
    prisma.sku.count({ where: { isActive: true, isService: false, name: { not: "回收机（其他机型）" } } }),
  ]);
  return (
    <SetupView
      demo={DEMO_MODE}
      company={company}
      license={license ? { ...license, state: licenseState(license, bjDateKey(new Date()), DEMO_MODE).kind } : null}
      methods={methods}
      allMethods={SELECTABLE_PAYMENT_METHODS}
      switches={switches}
      done={done}
      counts={{ stores, users, products }}
    />
  );
}
