import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { getOpeningBatch } from "@/server/import/import-service";
import { OpeningView } from "./opening-view";

export const dynamic = "force-dynamic";

// 期初入库单明细（口径第 22 节）：机器一台一行，配件一个商品一行。撤销后流水删了，只剩单头。
export default async function OpeningBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user.role !== "HQ") return <NoAccess subTitle="数据导入只有总部能看。" />;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) notFound();
  const data = await getOpeningBatch(user, id);
  if (!data) notFound();
  return <OpeningView data={data} />;
}
