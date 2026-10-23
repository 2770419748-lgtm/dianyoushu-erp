import { licenseNotice } from "@/lib/license";
import { requireUser } from "@/server/auth/current-user";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { getMenuForRole, ROLE_LABELS } from "@/server/auth/permissions";
import { wecomMode } from "@/server/wecom/config";
import { listMyNotifications } from "@/server/alerts/alert-service";
import { currentLicenseState } from "@/server/license/license-service";
import { getSetupDone } from "@/server/settings/settings-service";
import { AppShell, type ShellNotice } from "./app-shell";
import { ForcePassword } from "./force-password";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  // 还没改初始密码的人也要能看到外框和“先改密码”（页面本身的 requireUser 会把他们跳到 /first-password，不查数据）
  const user = await requireUser({ allowFirstPassword: true });

  const scopeLabel =
    user.role === "HQ"
      ? "全部门店"
      : user.role === "REGIONAL_MANAGER"
        ? (user.region?.name ?? "未分配区域")
        : (user.store?.name ?? "未分配门店");

  // 页面顶上的提醒（口径第 21 节）：快到期只提醒总部和店长；到期以后、只读、没开户每个人都看得到；总部没做完初始化提醒去做
  const notices: ShellNotice[] = [];
  const state = await currentLicenseState();
  const license = licenseNotice(state);
  if (license && (state.kind !== "expiring" || user.role === "HQ" || user.role === "STORE_MANAGER")) notices.push(license);
  if (user.role === "HQ" && !DEMO_MODE && !user.mustChangePassword && !(await getSetupDone())) notices.push({ level: "info", text: "还没完成初始化：公司信息、门店、员工、收款方式这些先设好再用", href: "/setup", linkText: "去初始化" });

  return (
    <AppShell
      user={{ name: user.name, roleLabel: ROLE_LABELS[user.role], scopeLabel }}
      menu={getMenuForRole(user.role, { wecom: wecomMode() !== "off" })}
      notifications={await listMyNotifications(user.id)}
      notices={notices}
    >
      {/* 第一次登录（开户的管理员、总部新建或重置过密码的人）先改密码，改完才能用别的 */}
      {user.mustChangePassword ? <ForcePassword next={user.role === "HQ" && !DEMO_MODE ? "/setup" : "/"} /> : children}
    </AppShell>
  );
}
