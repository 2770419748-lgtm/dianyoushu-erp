import { requireUser } from "@/server/auth/current-user";
import { isProtectedDemoAccount } from "@/server/auth/demo-accounts";
import { ROLE_LABELS } from "@/server/auth/permissions";
import { getMyProfile } from "@/server/hr/employee-service";
import { MeView } from "./me-view";

export const dynamic = "force-dynamic";

// 个人信息：看自己的账号、角色、所属门店或区域、自己的档案（工资只给本人看，口径第 19 节）；改自己的密码（演示账号不能改）。
export default async function MePage() {
  const user = await requireUser();
  return (
    <MeView
      info={{
        username: user.username,
        name: user.name,
        role: ROLE_LABELS[user.role],
        scope: user.store?.name ?? user.region?.name ?? (user.role === "HQ" ? "全部门店" : "未分配"),
      }}
      isDemo={isProtectedDemoAccount(user.username)}
      profile={await getMyProfile(user.id)}
    />
  );
}
