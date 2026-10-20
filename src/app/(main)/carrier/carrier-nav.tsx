"use client";

import { useRouter } from "next/navigation";
import { Segmented } from "antd";

type Tab = "list" | "stats" | "settlements" | "rules";

const TABS: { value: Tab; label: string; href: string; hqOnly?: boolean }[] = [
  { value: "list", label: "业务明细", href: "/carrier" },
  { value: "stats", label: "统计", href: "/carrier/stats" },
  { value: "settlements", label: "结算对账", href: "/carrier/settlements", hqOnly: true },
  { value: "rules", label: "佣金政策", href: "/carrier/rules", hqOnly: true },
];

/** 运营商业务几个页面之间切换（结算对账、佣金政策只有总部看得到） */
export function CarrierNav({ current, isHq }: { current: Tab; isHq: boolean }) {
  const router = useRouter();
  const tabs = TABS.filter((t) => isHq || !t.hqOnly);
  return <Segmented<Tab> value={current} options={tabs.map((t) => ({ value: t.value, label: t.label }))} onChange={(v) => router.push(tabs.find((t) => t.value === v)!.href)} style={{ marginBottom: 12 }} />;
}
