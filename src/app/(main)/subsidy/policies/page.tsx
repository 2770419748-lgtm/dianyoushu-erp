import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageSubsidy } from "@/server/auth/permissions";
import { listPolicies } from "@/server/subsidy/subsidy-service";
import { PoliciesView } from "./policies-view";

export const dynamic = "force-dynamic";

// 国补政策（口径第 15 节）：按大件品类（手机、平板）配补贴比例、单件封顶、单价上限和生效期，总部维护。
export default async function SubsidyPoliciesPage() {
  const user = await requireUser();
  if (!canManageSubsidy(user.role)) return <NoAccess subTitle="国补政策只有总部能改。" />;
  const rows = await listPolicies();
  return (
    <PoliciesView
      rows={rows.map((r) => ({
        categoryId: r.category.id,
        categoryName: r.category.name,
        policy: r.policy
          ? { rateBp: r.policy.rateBp, capFen: r.policy.capFen, priceCapFen: r.policy.priceCapFen, startsOn: r.policy.startsOn.toISOString().slice(0, 10), endsOn: r.policy.endsOn.toISOString().slice(0, 10), isActive: r.policy.isActive, note: r.policy.note, updatedAt: r.policy.updatedAt }
          : null,
      }))}
    />
  );
}
