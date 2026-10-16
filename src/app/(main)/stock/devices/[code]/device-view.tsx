"use client";

import Link from "next/link";
import { Button, Card, Descriptions, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import type { DeviceStatus, LedgerDocType } from "@/generated/prisma/enums";
import { formatDateTime, formatFen } from "@/lib/format";
import { DEVICE_STATUS_COLORS, DEVICE_STATUS_LABELS, LEDGER_DOC_TYPE_LABELS } from "@/lib/stock-labels";
import type { DeviceDetail } from "@/server/stock/stock-query";

type Ledger = DeviceDetail["ledgers"][number];

export function DeviceView({ device, showCost }: { device: DeviceDetail; showCost: boolean }) {
  const columns: TableColumnsType<Ledger> = [
    { title: "时间", dataIndex: "createdAt", width: 160, render: (v: Date) => formatDateTime(v) },
    { title: "动作", dataIndex: "docType", render: (t: LedgerDocType) => LEDGER_DOC_TYPE_LABELS[t] },
    { title: "单号", dataIndex: "docNo" },
    { title: "门店", render: (_, l) => `${l.store.code} ${l.store.name}` },
    {
      title: "状态变化",
      render: (_, l) => (
        <Space size={4}>
          {l.statusBefore ? <Tag color={DEVICE_STATUS_COLORS[l.statusBefore as DeviceStatus]}>{DEVICE_STATUS_LABELS[l.statusBefore as DeviceStatus]}</Tag> : <Tag>新入</Tag>}
          →
          {l.statusAfter ? <Tag color={DEVICE_STATUS_COLORS[l.statusAfter as DeviceStatus]}>{DEVICE_STATUS_LABELS[l.statusAfter as DeviceStatus]}</Tag> : "-"}
        </Space>
      ),
    },
    { title: "操作人", render: (_, l) => l.operator.name },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v ?? "" },
  ];

  const items = [
    { key: "code", label: "主码", children: device.code },
    { key: "sn", label: "SN", children: device.sn ?? "-" },
    { key: "imei1", label: "IMEI1", children: device.imei1 ?? "-" },
    { key: "imei2", label: "IMEI2", children: device.imei2 ?? "-" },
    { key: "sku", label: "商品", children: device.sku.name },
    { key: "model", label: "品牌 / 型号", children: `${device.sku.model.brand.name} ${device.sku.model.name}` },
    { key: "store", label: "当前归属", children: `${device.store.code} ${device.store.name}` },
    { key: "status", label: "状态", children: <Tag color={DEVICE_STATUS_COLORS[device.status]}>{DEVICE_STATUS_LABELS[device.status]}</Tag> },
    { key: "receipt", label: "入库单", children: device.goodsReceipt ? `${device.goodsReceipt.receiptNo}（${formatDateTime(device.goodsReceipt.createdAt)}）` : "-" },
    { key: "condition", label: "成色", children: device.condition ?? "-" },
  ];
  if (showCost) items.push({ key: "cost", label: "成本", children: `${formatFen(device.costFen)} 元` });

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={`机器 ${device.code}`}
        extra={
          <Link href="/stock">
            <Button size="small">返回库存</Button>
          </Link>
        }
      >
        <Descriptions column={{ xs: 1, md: 2 }} items={items} />
      </Card>
      <Card title={`全程流水（${device.ledgers.length}）`}>
        <Table rowKey="id" size="small" pagination={false} columns={columns} dataSource={device.ledgers} scroll={{ x: true }} />
      </Card>
    </Space>
  );
}
