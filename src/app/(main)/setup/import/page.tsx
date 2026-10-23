import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { listImports } from "@/server/import/import-service";
import { ImportView } from "./import-view";

export const dynamic = "force-dynamic";

// 数据导入（口径第 22 节）：门店、员工、商品、在库机器、配件期初、客户，下载模板 → 上传 → 预检 → 确认导入；下面是历次导入。只有总部。
export default async function ImportPage() {
  const user = await requireUser();
  if (user.role !== "HQ") return <NoAccess subTitle="数据导入只有总部能做。" />;
  return <ImportView history={await listImports(user)} />;
}
