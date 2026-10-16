"use client";

import { useRouter } from "next/navigation";
import { Card, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { auditActionLabel, auditEntityLabel } from "@/lib/audit-labels";
import { formatDateTime } from "@/lib/format";
import type { AuditLogRow } from "@/server/audit-query";

function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function LogsView({
  rows,
  total,
  current,
  pageSize,
}: {
  rows: AuditLogRow[];
  total: number;
  current: number;
  pageSize: number;
}) {
  const router = useRouter();

  const columns: TableColumnsType<AuditLogRow> = [
    { title: "时间", dataIndex: "createdAt", width: 160, render: (v: Date) => formatDateTime(v) },
    { title: "操作人", render: (_, r) => (r.user ? `${r.user.name}（${r.user.username}）` : "-") },
    { title: "动作", dataIndex: "action", render: (a: string) => auditActionLabel(a) },
    {
      title: "对象",
      render: (_, r) => (r.entity ? `${auditEntityLabel(r.entity)} #${r.entityId ?? ""}` : "-"),
    },
    { title: "详情", dataIndex: "detail", render: (d: unknown) => <Typography.Text type="secondary">{detailText(d)}</Typography.Text> },
    { title: "IP", dataIndex: "ip", render: (v: string | null) => v ?? "-" },
  ];

  return (
    <Card title={`操作日志（${total}）`}>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: true }}
        pagination={{
          current,
          pageSize,
          total,
          showSizeChanger: false,
          onChange: (page) => router.push(`/logs?page=${page}`),
        }}
      />
    </Card>
  );
}
