import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/current-user";

export const dynamic = "force-dynamic";

// “先改密码”页（口径第 21 节）：还没改初始密码的人打开任何页面都跳到这里。外框由主布局画，
// 布局见到 mustChangePassword 就在内容区显示改密码的表单；这一页本身不查任何业务数据。
export default async function FirstPasswordPage() {
  const user = await requireUser({ allowFirstPassword: true });
  if (!user.mustChangePassword) redirect("/");
  return null;
}
