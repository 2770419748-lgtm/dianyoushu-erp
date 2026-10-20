import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { wecomMode } from "@/server/wecom/config";
import { getKfSession, listKfSessions } from "@/server/wecom/kf-service";
import { KfView } from "./kf-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 微信客服（口径第 12 节第三步，总部）：会话列表、聊天记录；模拟模式下可以模拟客户发消息，走一遍真实的回调和自动答复。
export default async function WecomKfPage({ searchParams }: PageProps<"/wecom/kf">) {
  const mode = wecomMode();
  if (mode === "off") notFound();
  const user = await requireUser();
  if (user.role !== "HQ") return <NoAccess title="微信客服的会话只有总部能看" />;
  const sessionId = Number(one((await searchParams).session));
  const [list, detail] = await Promise.all([listKfSessions(user), Number.isInteger(sessionId) && sessionId > 0 ? getKfSession(user, sessionId) : Promise.resolve(null)]);
  return <KfView mode={mode} list={list} detail={detail} />;
}
