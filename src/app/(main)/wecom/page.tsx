import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { wecomMode } from "@/server/wecom/config";
import { getWecomOverview } from "@/server/wecom/overview-service";
import { WecomOverviewView } from "./wecom-overview-view";

export const dynamic = "force-dynamic";

// 企微对接（总部）：模式、配置、绑定数、最近的回调事件。企业微信对接关着（真给门店用又没开）时这一页不存在。
export default async function WecomPage() {
  if (wecomMode() === "off") notFound();
  const user = await requireUser();
  if (user.role !== "HQ") return <NoAccess />;
  return <WecomOverviewView data={await getWecomOverview(user)} />;
}
