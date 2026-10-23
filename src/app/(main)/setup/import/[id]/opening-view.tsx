"use client";

import Link from "next/link";
import { Alert, Card, Descriptions, Space, Table, Tag } from "antd";
import { formatDateTime, formatFen } from "@/lib/format";
import { IMPORT_KIND_LABELS, type ImportKindKey } from "@/lib/import/specs";

type Line = {
  id: number;
  qtyDelta: number;
  store: { code: string; name: string };
  sku: { name: string };
  device: { code: string; sn: string | null; imei1: string | null; imei2: string | null; costFen: number } | null;
};

type Data = {
  batch: {
    batchNo: string;
    kind: ImportKindKey;
    status: "DONE" | "REVOKED";
    fileName: string | null;
    rowCount: number;
    createdCount: number;
    summary: string[];
    createdAt: Date;
    createdBy: { name: string };
    revokedAt: Date | null;
    revokedBy: { name: string } | null;
  };
  lines: Line[];
};

export function OpeningView({ data }: { data: Data }) {
  const { batch, lines } = data;
  const isDevices = batch.kind === "DEVICES";
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card title={`期初入库单 ${batch.batchNo}`} extra={<Link href="/setup/import">返回数据导入</Link>}>
        <Descriptions size="small" column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label="类型">{IMPORT_KIND_LABELS[batch.kind]}</Descriptions.Item>
          <Descriptions.Item label="状态">{batch.status === "DONE" ? <Tag color="green">已导入</Tag> : <Tag color="red">已撤销</Tag>}</Descriptions.Item>
          <Descriptions.Item label="文件">{batch.fileName ?? ""}</Descriptions.Item>
          <Descriptions.Item label="导入人">{batch.createdBy.name}</Descriptions.Item>
          <Descriptions.Item label="时间">{formatDateTime(batch.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="新建">{batch.createdCount} 条</Descriptions.Item>
          <Descriptions.Item label="汇总" span={3}>
            {batch.summary.join("；")}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      {batch.status === "REVOKED" ? (
        <Alert type="warning" showIcon title={`已在 ${formatDateTime(batch.revokedAt!)} 由 ${batch.revokedBy?.name ?? ""} 撤销，这张单进来的库存已经撤掉`} />
      ) : (
        <Card title={isDevices ? `机器（${lines.length} 台）` : `配件（${lines.length} 行）`}>
          <Table
            size="small"
            rowKey="id"
            pagination={{ pageSize: 50, hideOnSinglePage: true }}
            dataSource={lines}
            columns={
              isDevices
                ? [
                    { title: "门店", key: "store", render: (_: unknown, l: Line) => `${l.store.code} ${l.store.name}` },
                    { title: "商品", key: "sku", render: (_: unknown, l: Line) => l.sku.name },
                    { title: "码", key: "code", render: (_: unknown, l: Line) => (l.device ? <Link href={`/stock/devices/${encodeURIComponent(l.device.code)}`}>{l.device.code}</Link> : "") },
                    { title: "SN", key: "sn", render: (_: unknown, l: Line) => l.device?.sn ?? "" },
                    { title: "IMEI2", key: "imei2", render: (_: unknown, l: Line) => l.device?.imei2 ?? "" },
                    { title: "成本", key: "cost", align: "right" as const, render: (_: unknown, l: Line) => (l.device ? formatFen(l.device.costFen) : "") },
                  ]
                : [
                    { title: "门店", key: "store", render: (_: unknown, l: Line) => `${l.store.code} ${l.store.name}` },
                    { title: "商品", key: "sku", render: (_: unknown, l: Line) => l.sku.name },
                    { title: "数量", dataIndex: "qtyDelta", align: "right" as const },
                  ]
            }
          />
        </Card>
      )}
    </Space>
  );
}
