import { requireUser } from "@/server/auth/current-user";
import { listNotices } from "@/server/notice/notice-service";
import { NoticesView } from "./notices-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 公告（口径第 19 节）：我能看的公告、读没读；总部、店长能发。
export default async function NoticesPage({ searchParams }: PageProps<"/notices">) {
  const user = await requireUser();
  const data = await listNotices(user, { page: Number(one((await searchParams).page)) || 1 });
  return <NoticesView data={data} />;
}
