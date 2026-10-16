"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Input, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { DeviceStatus, LedgerDocType } from "@/generated/prisma/enums";
import { formatDateTime } from "@/lib/format";
import { DEVICE_STATUS_LABELS, LEDGER_DOC_TYPE_LABELS } from "@/lib/stock-labels";
import type { LedgerRow } from "@/server/stock/stock-query";

export function LedgerView({
  stores,
  storeId,
  q,
  data,
}: {
  stores: { id: number; label: string }[];
  storeId?: number;
  q: string;
  data: { rows: LedgerRow[]; total: number; page: number; pageSize: number };
}) {
  const router = useRouter();

  function navigate(next: { storeId?: number; q?: string; page?: number }) {
    const sp = new URLSearchParams();
    const sid = "storeId" in next ? next.storeId : storeId;
    const text = next.q ?? q;
    if (sid) sp.set("storeId", String(sid));
    if (text) sp.set("q", text);
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/stock/ledger${sp.size ? `?${sp}` : ""}`);
  }

  const columns: TableColumnsType<LedgerRow> = [
    { title: "时间", dataIndex: "createdAt", width: 160, render: (v: Date) => formatDateTime(v) },
    { title: "类型", dataIndex: "docType", render: (t: LedgerDocType) => LEDGER_DOC_TYPE_LABELS[t] },
    { title: "单号", dataIndex: "docNo" },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "商品", render: (_, r) => r.sku.name },
    { title: "机器", render: (_, r) => (r.device ? <Link href={`/stock/devices/${r.device.code}`}>{r.device.code}</Link> : "-") },
    {
      title: "数量",
      dataIndex: "qtyDelta",
      align: "right",
      render: (v: number) => (v > 0 ? <Tag color="green">+{v}</Tag> : v < 0 ? <Tag color="red">{v}</Tag> : <Tag>0</Tag>),
    },
    {
      title: "变化",
      render: (_, r) =>
        r.device
          ? `${r.statusBefore ? DEVICE_STATUS_LABELS[r.statusBefore as DeviceStatus] : "新入"} → ${r.statusAfter ? DEVICE_STATUS_LABELS[r.statusAfter as DeviceStatus] : "-"}`
          : r.balanceAfter !== null
            ? `余额 ${r.balanceAfter}`
            : "-",
    },
    { title: "操作人", render: (_, r) => r.operator.name },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v ?? "" },
  ];

  return (
    <Card title={`库存流水（${data.total}）`}>
      <Typography.Paragraph type="secondary">所有库存变动都只能通过这张流水进出，余额随时能从流水重算。</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear={stores.length > 1}
          placeholder="全部门店"
          value={storeId}
          style={{ width: 220 }}
          showSearch
          optionFilterProp="label"
          options={stores.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(value) => navigate({ storeId: value })}
          disabled={stores.length === 1}
        />
        <Input.Search allowClear placeholder="搜单号、串号或商品名" defaultValue={q} style={{ width: 260 }} onSearch={(value) => navigate({ q: value })} />
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: true }}
        pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
      />
    </Card>
  );
}
