import { NoAccess } from "@/components/no-access";
import { isDbId } from "@/lib/paging";
import { requireUser } from "@/server/auth/current-user";
import { getPnl } from "@/server/finance/pnl-service";
import { PnlView } from "./pnl-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 门店收支和利润表（口径第 19 节）：按门店 × 月，收入、销货成本、毛利、费用、利润；店长本店（能录固定支出）、区域经理辖区（只看）、总部全部（有合计）。
export default async function PnlPage({ searchParams }: PageProps<"/finance/pnl">) {
  const user = await requireUser();
  if (user.role === "STAFF") return <NoAccess title="利润表店长、区域经理和总部能看" />;
  const params = await searchParams;
  const store = Number(one(params.store));
  const data = await getPnl(user, { month: one(params.month) || undefined, storeId: isDbId(store) ? store : undefined });
  return <PnlView data={data} />;
}
