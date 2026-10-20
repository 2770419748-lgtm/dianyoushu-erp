import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current-user";
import { getInvoice } from "@/server/invoice/invoice-service";
import { InvoiceDetailView } from "./invoice-detail-view";

export const dynamic = "force-dynamic";

// 发票详情（口径第 16 节）：销售方、购买方、明细和税额、状态；撤回、开具、红冲、纸质票到店。
export default async function InvoicePage({ params }: PageProps<"/invoices/[id]">) {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const invoice = await getInvoice(user, id);
  if (!invoice) notFound();
  return <InvoiceDetailView invoice={invoice} />;
}
