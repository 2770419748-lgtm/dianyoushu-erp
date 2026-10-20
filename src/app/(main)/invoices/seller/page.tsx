import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageInvoice } from "@/server/auth/permissions";
import { getSeller } from "@/server/invoice/invoice-service";
import { SellerForm } from "./seller-form";

export const dynamic = "force-dynamic";

// 公司开票信息（销售方，口径第 16 节）：总部维护一份，开具时存一份快照到发票上。
export default async function InvoiceSellerPage() {
  const user = await requireUser();
  if (!canManageInvoice(user.role)) return <NoAccess subTitle="公司开票信息只有总部能改。" />;
  const seller = await getSeller();
  return <SellerForm seller={seller ? { name: seller.name, taxNo: seller.taxNo, addressPhone: seller.addressPhone, bankAccount: seller.bankAccount } : null} />;
}
