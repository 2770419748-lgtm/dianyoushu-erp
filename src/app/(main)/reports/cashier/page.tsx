import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { cashierReport, DailyCloseError } from "@/server/dailyclose/daily-close-service";
import { parseReportRange } from "@/server/dailyclose/report-query";
import { listStoresInScope } from "@/server/org/store-query";
import { CashierReportView } from "./cashier-report-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 收银日报：按门店 × 营业日汇总各收款方式（收款 − 退款），带日结状态；店长本店、区域经理辖区、总部全部。
export default async function CashierReportPage({ searchParams }: PageProps<"/reports/cashier">) {
  const user = await requireUser();
  if (user.role === "STAFF") return <NoAccess title="收银日报要店长、区域经理或总部" />;
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : undefined;

  let range: ReturnType<typeof parseReportRange>;
  try {
    range = parseReportRange(one(params.from), one(params.to));
  } catch (error) {
    if (error instanceof DailyCloseError) return <NoAccess title={error.message} />;
    throw error;
  }
  const rows = await cashierReport(user, { from: range.from, to: range.to, storeId });
  return <CashierReportView stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} storeId={storeId} from={range.fromText} to={range.toText} rows={rows} />;
}
