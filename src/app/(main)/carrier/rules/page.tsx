import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageCarrier } from "@/server/auth/permissions";
import { listCommissionRules } from "@/server/carrier/carrier-service";
import { RulesView } from "./rules-view";

export const dynamic = "force-dynamic";

// 运营商佣金政策（口径第 14 节）：总部按“运营商 + 业务类型”配每笔佣金和返销期；改了只影响以后登记的。
export default async function CarrierRulesPage() {
  const user = await requireUser();
  if (!canManageCarrier(user.role)) return <NoAccess subTitle="运营商佣金政策只有总部能改。" />;
  const rules = await listCommissionRules();
  return <RulesView rules={rules.map((r) => ({ carrier: r.carrier, bizType: r.bizType, commissionFen: r.commissionFen, clawbackMonths: r.clawbackMonths, isActive: r.isActive, note: r.note, updatedAt: r.updatedAt }))} />;
}
