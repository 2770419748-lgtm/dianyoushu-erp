import { notFound } from "next/navigation";
import { isDbId } from "@/lib/paging";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { getInvoice } from "@/server/invoice/invoice-service";
import { InvoiceDetailView } from "./invoice-detail-view";

export const dynamic = "force-dynamic";

// 发票详情（口径第 16 节）：销售方、购买方、明细和税额、状态；撤回、开具、红冲、纸质票到店。
export default async function InvoicePage({ params }: PageProps<"/invoices/[id]">) {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!isDbId(id)) notFound();
  const invoice = await getInvoice(user, id).catch((error: unknown) => {
    if (error instanceof PermissionError) return "forbidden" as const;
    throw error;
  });
  if (invoice === "forbidden") return <NoAccess title="没有权限看这张发票" />;
  if (!invoice) notFound();
  return <InvoiceDetailView invoice={invoice} />;
}
