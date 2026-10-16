"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime } from "@/lib/format";
import { TRANSFER_STATUS_COLORS, TRANSFER_STATUS_LABELS } from "@/lib/stock-labels";
import type { TransferRow } from "@/server/transfer/transfer-service";

export function TransferListView({
  rows,
  total,
  page,
  pageSize,
  canManage,
}: {
  rows: TransferRow[];
  total: number;
  page: number;
  pageSize: number;
  canManage: boolean;
}) {
  const router = useRouter();

  const columns: TableColumnsType<TransferRow> = [
    { title: "单号", dataIndex: "orderNo", render: (no: string, r) => <Link href={`/transfers/${r.id}`}>{no}</Link> },
    { title: "发出店", render: (_, r) => `${r.fromStore.code} ${r.fromStore.name}` },
    { title: "收货店", render: (_, r) => `${r.toStore.code} ${r.toStore.name}` },
    { title: "状态", dataIndex: "status", render: (s: TransferRow["status"]) => <Tag color={TRANSFER_STATUS_COLORS[s]}>{TRANSFER_STATUS_LABELS[s]}</Tag> },
    { title: "机器 / 配件", render: (_, r) => `${r.items.filter((i) => i.deviceId).length} 台 / ${r.items.filter((i) => !i.deviceId).reduce((s, i) => s + i.qty, 0)} 件` },
    { title: "已收 / 应收", render: (_, r) => `${r.items.reduce((s, i) => s + i.receivedQty, 0)} / ${r.items.reduce((s, i) => s + i.qty, 0)}` },
    { title: "申请人", render: (_, r) => r.requestedBy.name },
    { title: "申请时间", dataIndex: "requestedAt", render: (v: Date) => formatDateTime(v) },
  ];

  return (
    <Card
      title={`调拨单（${total}）`}
      extra={
        canManage ? (
          <Link href="/transfers/new">
            <Button type="primary">新建调拨</Button>
          </Link>
        ) : null
      }
    >
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: true }}
        pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (p) => router.push(`/transfers?page=${p}`) }}
      />
    </Card>
  );
}
