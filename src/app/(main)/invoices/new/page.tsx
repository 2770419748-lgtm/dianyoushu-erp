import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current-user";
import { invoiceDraft } from "@/server/invoice/invoice-service";
import { InvoiceRequestForm } from "./invoice-request-form";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 申请开票（口径第 16 节）：从销售单进来，显示能开多少和明细，填抬头；同一个客户上次的抬头自动带出。
export default async function NewInvoicePage({ searchParams }: PageProps<"/invoices/new">) {
  const user = await requireUser();
  const orderId = Number(one((await searchParams).orderId));
  if (!Number.isInteger(orderId) || orderId <= 0) notFound();
  const draft = await invoiceDraft(user, orderId);
  if (!draft) notFound();
  return <InvoiceRequestForm draft={draft} />;
}
