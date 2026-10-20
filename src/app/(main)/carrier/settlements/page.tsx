import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { canManageCarrier } from "@/server/auth/permissions";
import { listSettlements } from "@/server/carrier/carrier-service";
import { todayBizDate } from "@/server/stock/doc-no";
import { SettlementsView } from "./settlements-view";

export const dynamic = "force-dynamic";

// 运营商结算对账（口径第 14 节）：总部每月导入运营商结算单，系统按受理单号、号码对账。
export default async function CarrierSettlementsPage() {
  const user = await requireUser();
  if (!canManageCarrier(user.role)) return <NoAccess subTitle="运营商结算对账只有总部能做。" />;
  const rows = await listSettlements(user);
  const today = todayBizDate();
  const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  return (
    <SettlementsView
      rows={rows.map((r) => ({ id: r.id, settlementNo: r.settlementNo, carrier: r.carrier, month: r.month, source: r.source, importedBy: r.importedBy.name, createdAt: r.createdAt, lineCount: r.lineCount, matchedCount: r.matchedCount, diffCount: r.diffCount, unmatchedCount: r.unmatchedCount, missingCount: r.missingCount, totalCommissionFen: r.totalCommissionFen, totalClawbackFen: r.totalClawbackFen }))}
      defaultMonth={lastMonth}
      canSimulate={DEMO_MODE}
    />
  );
}
