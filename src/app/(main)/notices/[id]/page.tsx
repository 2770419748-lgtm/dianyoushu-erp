import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current-user";
import { getNotice } from "@/server/notice/notice-service";
import { NoticeDetailView } from "./notice-detail-view";

export const dynamic = "force-dynamic";

// 公告详情：打开就算已读；发布人和总部看已读人数、谁还没读，能撤下。
export default async function NoticePage({ params }: PageProps<"/notices/[id]">) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const user = await requireUser();
  const notice = await getNotice(user, id);
  if (!notice) notFound();
  return <NoticeDetailView notice={notice} />;
}
