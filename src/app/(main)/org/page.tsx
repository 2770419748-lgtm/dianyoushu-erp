import { requireUser } from "@/server/auth/current-user";
import { canManageOrg } from "@/server/auth/permissions";
import { getOrgTree } from "@/server/org/org-service";
import { wecomMode } from "@/server/wecom/config";
import { NoAccess } from "@/components/no-access";
import { OrgView } from "./org-view";

export const dynamic = "force-dynamic";

export default async function OrgPage() {
  const user = await requireUser();
  if (!canManageOrg(user.role)) return <NoAccess />;
  const data = await getOrgTree(user);
  return <OrgView data={data} currentUserId={user.id} showWecom={wecomMode() !== "off"} />;
}
