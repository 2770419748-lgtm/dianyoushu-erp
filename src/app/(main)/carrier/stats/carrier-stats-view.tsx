"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Input, Segmented, Select, Space, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { CARRIER_BIZ_TYPE_LABELS, type CarrierBizTypeKey } from "@/lib/carrier";
import { formatFen } from "@/lib/format";
import type { carrierStats } from "@/server/carrier/carrier-service";
import { CarrierNav } from "../carrier-nav";

type Stats = Awaited<ReturnType<typeof carrierStats>>;
type Row = Stats["byStore"][number];
type GroupKey = "byStore" | "byStaff" | "byCarrier" | "byType";

const GROUPS: { value: GroupKey; label: string }[] = [
  { value: "byStore", label: "按门店" },
  { value: "byStaff", label: "按员工" },
  { value: "byCarrier", label: "按运营商" },
  { value: "byType", label: "按业务类型" },
];

export function CarrierStatsView({ stats, month, storeId, stores, isHq }: { stats: Stats; month: string; storeId?: number; stores: { id: number; label: string }[]; isHq: boolean }) {
  const router = useRouter();
  const [group, setGroup] = useState<GroupKey>("byStore");

  function navigate(next: { month?: string; storeId?: number | null }) {
    const sp = new URLSearchParams();
    sp.set("month", next.month ?? month);
    const s = next.storeId === undefined ? storeId : next.storeId;
    if (s) sp.set("storeId", String(s));
    router.push(`/carrier/stats?${sp}`);
  }

  const rows = stats[group];
  const sum = (k: "count" | "activated" | "failed" | "expectedFen" | "settledFen" | "clawbackFen") => rows.reduce((s, r) => s + r[k], 0);
  const columns: TableColumnsType<Row> = [
    { title: GROUPS.find((g) => g.value === group)!.label.replace("按", ""), dataIndex: "label", render: (v: string) => (group === "byType" ? CARRIER_BIZ_TYPE_LABELS[v as CarrierBizTypeKey] : v) },
    { title: "登记笔数", dataIndex: "count", align: "right" },
    { title: "开通", dataIndex: "activated", align: "right" },
    { title: "失败", dataIndex: "failed", align: "right" },
    { title: "预计佣金（元）", dataIndex: "expectedFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "实收佣金（元）", dataIndex: "settledFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "扣回（元）", dataIndex: "clawbackFen", align: "right", render: (v: number) => (v ? <Typography.Text type="danger">{formatFen(v)}</Typography.Text> : "0.00") },
  ];

  return (
    <Card title={`运营商业务统计（${month}，${stats.total} 笔）`}>
      <CarrierNav current="stats" isHq={isHq} />
      <Space wrap style={{ marginBottom: 12 }}>
        <Input placeholder="月份 2026-09" defaultValue={month} style={{ width: 130 }} onPressEnter={(e) => navigate({ month: (e.target as HTMLInputElement).value.trim() })} />
        {stores.length > 1 ? <Select allowClear placeholder="全部门店" style={{ width: 180 }} value={storeId} options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => navigate({ storeId: v ?? null })} /> : null}
        <Segmented<GroupKey> value={group} options={GROUPS} onChange={setGroup} />
      </Space>
      <Typography.Paragraph type="secondary">预计佣金按开通的笔数算（登记时的政策）；实收和扣回来自总部导入的运营商结算单，当月一般要到下月对账后才有。</Typography.Paragraph>
      <Table
        rowKey="key"
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: true }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="right">{sum("count")}</Table.Summary.Cell>
            <Table.Summary.Cell index={2} align="right">{sum("activated")}</Table.Summary.Cell>
            <Table.Summary.Cell index={3} align="right">{sum("failed")}</Table.Summary.Cell>
            <Table.Summary.Cell index={4} align="right">{formatFen(sum("expectedFen"))}</Table.Summary.Cell>
            <Table.Summary.Cell index={5} align="right">{formatFen(sum("settledFen"))}</Table.Summary.Cell>
            <Table.Summary.Cell index={6} align="right">{formatFen(sum("clawbackFen"))}</Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
    </Card>
  );
}
