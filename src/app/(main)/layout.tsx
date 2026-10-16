import { requireUser } from "@/server/auth/current-user";
import { getMenuForRole, ROLE_LABELS } from "@/server/auth/permissions";
import { AppShell } from "./app-shell";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  const scopeLabel =
    user.role === "HQ"
      ? "全部门店"
      : user.role === "REGIONAL_MANAGER"
        ? (user.region?.name ?? "未分配区域")
        : (user.store?.name ?? "未分配门店");

  return (
    <AppShell
      user={{ name: user.name, roleLabel: ROLE_LABELS[user.role], scopeLabel }}
      menu={getMenuForRole(user.role)}
    >
      {children}
    </AppShell>
  );
}
