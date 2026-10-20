import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { demoClaimHint, getSidebarProfile, SidebarError, sidebarUserFromToken } from "@/server/wecom/sidebar-service";
import { SIDEBAR_COOKIE } from "@/server/wecom/sidebar-token";
import { WECOM_JSSDK_URLS, wecomMode } from "@/server/wecom/config";
import { SidebarMessage } from "./sidebar-message";
import { RealContactLoader } from "./real-contact-loader";
import { SidebarProfileView } from "./sidebar-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 企微侧边栏：客户画像（口径第 12 节第三步）。当前聊天的客户 id 在地址里：真对接时由页面上的 JS-SDK 拿到后填进来，
// 模拟模式由演示页带进来。不管哪种，服务端都先核对“这个员工和这个客户是好友”才给看。
export default async function SidebarCustomerPage({ searchParams }: PageProps<"/wecom-app/customer">) {
  const mode = wecomMode();
  if (mode === "off") notFound();
  const user = await sidebarUserFromToken((await cookies()).get(SIDEBAR_COOKIE)?.value);
  if (!user) {
    if (mode === "real") redirect("/wecom-app/auth");
    return <SidebarMessage title="侧边栏登录过期了" subTitle="回到“企微侧边栏”演示页，重新点一下左边的客户。" />;
  }
  const externalUserid = one((await searchParams).externalUserid);
  if (!externalUserid) {
    if (mode === "real") return <RealContactLoader scripts={[...WECOM_JSSDK_URLS]} />;
    return <SidebarMessage title="在左边选一个客户" subTitle="真用时，这里显示的是你正在企业微信里聊天的那个客户。" />;
  }
  const profile = await getSidebarProfile(user, externalUserid).catch((error: unknown) => {
    if (error instanceof SidebarError) return error;
    throw error;
  });
  if (profile instanceof SidebarError) return <SidebarMessage status="warning" title={profile.message} />;
  const hint = mode === "simulated" && !profile.bound ? await demoClaimHint(user) : null;
  return <SidebarProfileView profile={profile} externalUserid={externalUserid} demoHint={hint} />;
}
