import type { InvoiceStatus } from "@/generated/prisma/enums";
import { requireUser } from "@/server/auth/current-user";
import { invoiceSummary, listInvoices } from "@/server/invoice/invoice-service";
import { listStoresInScope } from "@/server/org/store-query";
import { InvoicesView } from "./invoices-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const STATUSES: InvoiceStatus[] = ["REQUESTED", "ISSUED", "RED_PENDING", "REDDED", "CANCELLED"];

// 发票（口径第 16 节）：上面按门店汇总（待开票、本月开票、需红冲、电子票占比），下面发票列表；开具、红冲在详情页。
export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const user = await requireUser();
  const params = await searchParams;
  const stores = await listStoresInScope(user);
  const requested = Number(one(params.storeId));
  const query = {
    status: STATUSES.find((s) => s === one(params.status)),
    storeId: stores.some((s) => s.id === requested) ? requested : undefined,
    month: /^\d{4}-\d{2}$/.test(one(params.month)) ? one(params.month) : undefined,
    q: one(params.q),
    page: Number(one(params.page)) || 1,
  };
  const [data, summary] = await Promise.all([listInvoices(user, query), invoiceSummary(user, { storeId: query.storeId })]);
  return <InvoicesView data={data} summary={summary} query={query} stores={stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))} />;
}
