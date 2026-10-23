import Link from "next/link";
import { Button, Result } from "antd";
import { LICENSE_PLAN_LABELS, licenseNotice } from "@/lib/license";
import { requireUser } from "@/server/auth/current-user";
import { currentLicenseState } from "@/server/license/license-service";

export const dynamic = "force-dynamic";

// 服务到期只读（口径第 21 节）：改数据的操作都会跳到这里，说明现在能做什么、怎么续费。
export default async function ExpiredPage() {
  await requireUser();
  const state = await currentLicenseState();
  const notice = licenseNotice(state);
  const license = "license" in state ? state.license : null;
  return (
    <Result
      status={notice ? "warning" : "success"}
      title={notice ? "服务已到期，现在只能查看和导出" : "服务正常"}
      subTitle={
        notice
          ? `${notice.text}。${license ? `（${LICENSE_PLAN_LABELS[license.plan]}，到期日 ${license.expiresOn}）` : ""}改自己的密码、二次验证、退出、看消息还能用；数据都还在，不会自动删。`
          : "可以照常开单和改数据了。"
      }
      extra={
        <Link href="/">
          <Button type="primary">回首页</Button>
        </Link>
      }
    />
  );
}
