"use client";

import Link from "next/link";
import { Card, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { RepairPayer, RepairStatus } from "@/generated/prisma/enums";
import { formatDateTime, formatFen } from "@/lib/format";
import { REPAIR_PAYER_LABELS, REPAIR_STATUS_COLORS, REPAIR_STATUS_LABELS } from "@/lib/repair";
import type { RepairHistoryRow } from "@/server/repair/repair-service";

/** 机器详情、客户详情里的维修记录：看不了的门店只给摘要，没有链接 */
export function RepairHistory({ rows, title = "维修记录" }: { rows: RepairHistoryRow[]; title?: string }) {
  const columns: TableColumnsType<RepairHistoryRow> = [
    { title: "维修单", render: (_, r) => (r.id ? <Link href={`/repairs/${r.id}`}>{r.orderNo}</Link> : <Typography.Text type="secondary">{r.orderNo}</Typography.Text>) },
    { title: "接件时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
    { title: "门店", dataIndex: "store" },
    { title: "机型", dataIndex: "modelName" },
    { title: "故障", dataIndex: "fault" },
    { title: "谁付", dataIndex: "payer", render: (p: RepairPayer | null) => (p ? REPAIR_PAYER_LABELS[p] : "-") },
    { title: "客户应付（元）", dataIndex: "chargeFen", align: "right", render: (v: number, r) => (r.payer ? formatFen(v) : "-") },
    { title: "状态", dataIndex: "status", render: (s: RepairStatus) => <Tag color={REPAIR_STATUS_COLORS[s]}>{REPAIR_STATUS_LABELS[s]}</Tag> },
  ];
  return (
    <Card title={`${title}（${rows.length}）`}>
      <Table rowKey="key" size="small" columns={columns} dataSource={rows} pagination={false} scroll={{ x: true }} locale={{ emptyText: "没有维修记录" }} />
    </Card>
  );
}
