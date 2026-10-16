"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime, formatFen } from "@/lib/format";
import { PURCHASE_STATUS_COLORS, PURCHASE_STATUS_LABELS } from "@/lib/stock-labels";
import type { PurchaseOrderRow } from "@/server/purchase/purchase-service";

export function PurchaseListView({
  rows,
  total,
  page,
  pageSize,
  canManage,
}: {
  rows: PurchaseOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  canManage: boolean;
}) {
  const router = useRouter();

  const columns: TableColumnsType<PurchaseOrderRow> = [
    { title: "单号", dataIndex: "orderNo", render: (no: string, r) => <Link href={`/purchase/${r.id}`}>{no}</Link> },
    { title: "收货门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "供应商", dataIndex: "supplierName", render: (v: string | null) => v ?? "-" },
    { title: "状态", dataIndex: "status", render: (s: PurchaseOrderRow["status"]) => <Tag color={PURCHASE_STATUS_COLORS[s]}>{PURCHASE_STATUS_LABELS[s]}</Tag> },
    {
      title: "数量（已到 / 应到）",
      render: (_, r) => `${r.items.reduce((s, i) => s + i.receivedQty, 0)} / ${r.items.reduce((s, i) => s + i.qty, 0)}`,
    },
    { title: "金额（元）", align: "right", render: (_, r) => formatFen(r.items.reduce((s, i) => s + i.qty * i.unitCostFen, 0)) },
    { title: "创建人", render: (_, r) => r.createdBy.name },
    { title: "创建时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
  ];

  return (
    <Card
      title={`采购单（${total}）`}
      extra={
        canManage ? (
          <Link href="/purchase/new">
            <Button type="primary">新建采购单</Button>
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
        pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (p) => router.push(`/purchase?page=${p}`) }}
      />
    </Card>
  );
}
