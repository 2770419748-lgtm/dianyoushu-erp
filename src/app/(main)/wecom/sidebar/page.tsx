import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current-user";
import { wecomMode } from "@/server/wecom/config";
import { listMyContacts } from "@/server/wecom/sidebar-service";
import { SidebarDemoView } from "./sidebar-demo-view";

export const dynamic = "force-dynamic";

// 企微侧边栏（口径第 12 节第三步）。模拟模式：模拟一个企业微信聊天窗口，左边是我的企业微信好友，右边打开真正的侧边栏页面；
// 真对接：侧边栏在企业微信里用，这一页只说明怎么在企业微信后台配置聊天工具栏。
export default async function WecomSidebarPage() {
  const mode = wecomMode();
  if (mode === "off") notFound();
  const user = await requireUser();
  const data = mode === "simulated" ? await listMyContacts(user) : null;
  return <SidebarDemoView mode={mode} data={data} />;
}
