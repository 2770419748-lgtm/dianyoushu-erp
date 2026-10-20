"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Input, Segmented, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { RepairPayer, RepairStatus } from "@/generated/prisma/enums";
import { formatDateTime, formatFen } from "@/lib/format";
import { REPAIR_PAYER_LABELS, REPAIR_STATUS_COLORS, REPAIR_STATUS_LABELS } from "@/lib/repair";
import type { listRepairs, RepairListView, RepairRow } from "@/server/repair/repair-service";

type Data = Awaited<ReturnType<typeof listRepairs>>;

const VIEW_LABELS: Record<RepairListView, string> = { open: "进行中", ready: "待取机", closed: "已完结", all: "全部" };

export function RepairsView({ data, view, q, stores, storeId }: { data: Data; view: RepairListView; q: string; stores: { id: number; label: string }[]; storeId?: number }) {
  const router = useRouter();

  function navigate(next: { view?: RepairListView; storeId?: number | null; q?: string; page?: number }) {
    const sp = new URLSearchParams();
    const v = next.view ?? view;
    if (v !== "open") sp.set("view", v);
    const s = next.storeId === undefined ? storeId : next.storeId;
    if (s) sp.set("storeId", String(s));
    const text = next.q ?? q;
    if (text) sp.set("q", text);
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/repairs${sp.size ? `?${sp}` : ""}`);
  }

  const columns: TableColumnsType<RepairRow> = [
    { title: "维修单", render: (_, r) => <Link href={`/repairs/${r.id}`}>{r.orderNo}</Link> },
    { title: "接件时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
    { title: "门店", dataIndex: "store" },
    { title: "客户", dataIndex: "customer" },
    {
      title: "机器",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          {r.modelName}
          <Typography.Text type="secondary">{r.deviceCode}</Typography.Text>
        </Space>
      ),
    },
    { title: "故障", dataIndex: "fault" },
    { title: "状态", dataIndex: "status", render: (s: RepairStatus) => <Tag color={REPAIR_STATUS_COLORS[s]}>{REPAIR_STATUS_LABELS[s]}</Tag> },
    { title: "谁付", dataIndex: "payer", render: (p: RepairPayer | null) => (p ? REPAIR_PAYER_LABELS[p] : "-") },
    { title: "客户应付（元）", dataIndex: "chargeFen", align: "right", render: (v: number, r) => (r.payer ? formatFen(v) : "-") },
    { title: "接件人", dataIndex: "receivedBy" },
  ];

  return (
    <Card
      title={`售后维修（${data.total}）`}
      extra={
        data.canCreate ? (
          <Link href="/repairs/new">
            <Button type="primary">接件</Button>
          </Link>
        ) : null
      }
    >
      <Typography.Paragraph type="secondary">接件 → 检测报价 → 维修 → 取机结算。本店卖出的机器自动带出购买记录、保修和碎屏险、延保；客户的机器不算门店库存。</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented<RepairListView> value={view} options={(Object.keys(VIEW_LABELS) as RepairListView[]).map((v) => ({ value: v, label: VIEW_LABELS[v] }))} onChange={(v) => navigate({ view: v, page: 1 })} />
        {stores.length > 1 ? (
          <Select allowClear placeholder="全部门店" style={{ width: 200 }} value={storeId} options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => navigate({ storeId: v ?? null, page: 1 })} />
        ) : null}
        <Input.Search allowClear placeholder="单号、串号或机型" defaultValue={q} style={{ width: "min(260px, 100%)" }} onSearch={(v) => navigate({ q: v, page: 1 })} />
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: true }}
        locale={{ emptyText: "没有维修单" }}
        pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
      />
    </Card>
  );
}
