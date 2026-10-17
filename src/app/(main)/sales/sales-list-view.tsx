"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Select, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime, formatFen } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, SALES_STATUS_COLORS, SALES_STATUS_LABELS } from "@/lib/sales-labels";
import type { SalesOrderRow } from "@/server/sales/sales-service";

export function SalesListView({
  rows,
  total,
  page,
  pageSize,
  stores,
  storeId,
  canCreate,
}: {
  rows: SalesOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  stores: { id: number; label: string }[];
  storeId?: number;
  canCreate: boolean;
}) {
  const router = useRouter();

  function navigate(next: { storeId?: number; page?: number }) {
    const sp = new URLSearchParams();
    const sid = "storeId" in next ? next.storeId : storeId;
    if (sid) sp.set("storeId", String(sid));
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/sales${sp.size ? `?${sp}` : ""}`);
  }

  const columns: TableColumnsType<SalesOrderRow> = [
    { title: "单号", dataIndex: "orderNo", render: (no: string, r) => <Link href={`/sales/${r.id}`}>{no}</Link> },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "客户", render: (_, r) => (r.customer ? `${r.customer.name} ${r.customer.phoneMasked}` : "散客") },
    { title: "商品数", render: (_, r) => r._count.items },
    { title: "应收（元）", dataIndex: "totalFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "收款方式", render: (_, r) => r.payments.map((p) => PAYMENT_METHOD_LABELS[p.method]).join(" + ") },
    { title: "状态", dataIndex: "status", render: (s: SalesOrderRow["status"]) => <Tag color={SALES_STATUS_COLORS[s]}>{SALES_STATUS_LABELS[s]}</Tag> },
    { title: "销售员", render: (_, r) => r.salesperson.name },
    { title: "时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
  ];

  return (
    <Card
      title={`销售单（${total}）`}
      extra={
        canCreate ? (
          <Link href="/sales/new">
            <Button type="primary">开单</Button>
          </Link>
        ) : null
      }
    >
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear={stores.length > 1}
          placeholder="全部门店"
          // 只能看一家店的人（店员、店长）直接显示这家店，别显示成“全部门店”
          value={stores.length === 1 ? stores[0]!.id : storeId}
          style={{ width: 220 }}
          showSearch
          optionFilterProp="label"
          options={stores.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(value) => navigate({ storeId: value, page: 1 })}
          disabled={stores.length === 1}
        />
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: true }}
        pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
      />
    </Card>
  );
}
