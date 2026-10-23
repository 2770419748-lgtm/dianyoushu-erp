import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { DEMO_MODE } from "@/server/auth/demo-accounts";
import { ClearStaleSession } from "./clear-stale-session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const user = await getCurrentUser();
  if (user) redirect("/");
  const reason = (await searchParams).reason;
  const notice = reason === "expired" || reason === "inactive" ? "登录已失效：密码可能被修改过，或账号已停用。请重新登录，登不上就联系店长或总部。" : undefined;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "#f5f5f5",
      }}
    >
      {reason === "expired" ? <ClearStaleSession /> : null}
      <LoginForm notice={notice} showDemoAccounts={DEMO_MODE} />
    </main>
  );
}
