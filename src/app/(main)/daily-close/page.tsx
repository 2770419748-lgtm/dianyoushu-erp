import { NoAccess } from "@/components/no-access";
import { formatDate } from "@/lib/format";
import { requireUser } from "@/server/auth/current-user";
import { canCloseDay } from "@/server/auth/permissions";
import { DailyCloseError, getDailyCloseView, parseBizDate } from "@/server/dailyclose/daily-close-service";
import { listStoresInScope } from "@/server/org/store-query";
import { DailyCloseView } from "./daily-close-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 日结：选门店和营业日，看系统汇总和逐笔订单，录实收，确认。区域经理只能看。
export default async function DailyClosePage({ searchParams }: PageProps<"/daily-close">) {
  const user = await requireUser();
  if (user.role === "STAFF") return <NoAccess title="日结要店长或总部" />;
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  if (stores.length === 0) return <NoAccess title="你没有可看的门店" />;
  const requested = Number(one(params.storeId));
  const storeId = stores.some((s) => s.id === requested) ? requested : (user.storeId ?? stores[0]!.id);
  const dateText = one(params.date) || formatDate(new Date());

  let bizDate: Date;
  try {
    bizDate = parseBizDate(dateText);
  } catch (error) {
    if (error instanceof DailyCloseError) return <NoAccess title={error.message} />;
    throw error;
  }
  const view = await getDailyCloseView(user, storeId, bizDate);
  return (
    <DailyCloseView
      stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      storeId={storeId}
      dateText={dateText}
      view={view}
      canClose={canCloseDay(user.role)}
      canReopen={user.role === "HQ"}
    />
  );
}
