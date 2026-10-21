import { notFound } from "next/navigation";
import { isDbId } from "@/lib/paging";
import { requireUser } from "@/server/auth/current-user";
import { NoAccess } from "@/components/no-access";
import { dropStaleNotice, getNotice } from "@/server/notice/notice-service";
import { NoticeDetailView } from "./notice-detail-view";

export const dynamic = "force-dynamic";

// 公告详情：打开就算已读；发布人和总部看已读人数、谁还没读，能撤下。
export default async function NoticePage({ params }: PageProps<"/notices/[id]">) {
  const id = Number((await params).id);
  if (!isDbId(id)) notFound();
  const user = await requireUser();
  const notice = await getNotice(user, id);
  if (!notice) {
    // 调了店、换了区域：小铃铛里还留着原来范围的公告，点开时清掉这条、说清楚原因
    if (await dropStaleNotice(user.id, id)) return <NoAccess title="这条公告不在你现在的范围里了" subTitle="可能是调了门店或者公告已经撤下，消息里的这一条已经清掉。" />;
    notFound();
  }
  return <NoticeDetailView notice={notice} />;
}
