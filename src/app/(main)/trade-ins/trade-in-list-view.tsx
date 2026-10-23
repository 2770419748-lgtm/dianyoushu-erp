"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import type { DeviceStatus } from "@/generated/prisma/enums";
import { formatDateTime, formatFen } from "@/lib/format";
import { DEVICE_STATUS_COLORS, DEVICE_STATUS_LABELS } from "@/lib/stock-labels";
import type { TradeInRow } from "@/server/tradein/trade-in-service";
import { revealSellerIdAction } from "./actions";

/** 卖家身份证号：默认打码；店长及以上点“显示”在服务端解开（记日志） */
function SellerId({ row, canReveal }: { row: TradeInRow; canReveal: boolean }) {
  const { message } = App.useApp();
  const [full, setFull] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (!row.sellerIdMasked) return <>-</>;
  if (full) return <>{full}</>;
  return (
    <Space size={4}>
      {row.sellerIdMasked}
      {canReveal ? (
        <Button
          type="link"
          size="small"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await revealSellerIdAction(row.id);
              if (r.ok) setFull(r.idNo);
              else message.error(r.error);
            })
          }
        >
          显示
        </Button>
      ) : null}
    </Space>
  );
}

export function TradeInListView({
  rows,
  total,
  page,
  pageSize,
  canCreate,
  canRefurbish,
  canSeeSellerId,
}: {
  rows: TradeInRow[];
  total: number;
  page: number;
  pageSize: number;
  canCreate: boolean;
  canRefurbish: boolean;
  canSeeSellerId: boolean;
}) {
  const router = useRouter();

  const columns: TableColumnsType<TradeInRow> = [
    { title: "单号", dataIndex: "orderNo" },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "旧机", render: (_, r) => r.modelName },
    { title: "主码", dataIndex: "deviceCode", render: (code: string) => <Link href={`/stock/devices/${code}`}>{code}</Link> },
    { title: "成色", dataIndex: "condition" },
    { title: "估价（元）", dataIndex: "appraisedFen", align: "right", render: (v: number) => formatFen(v) },
    {
      title: "机器状态",
      render: (_, r) => (r.device ? <Tag color={DEVICE_STATUS_COLORS[r.device.status as DeviceStatus]}>{DEVICE_STATUS_LABELS[r.device.status as DeviceStatus]}</Tag> : "-"),
    },
    {
      title: "抵扣",
      render: (_, r) => (r.salesOrder ? <Link href={`/sales/${r.salesOrder.id}`}>{r.salesOrder.orderNo}</Link> : <Tag>未使用</Tag>),
    },
    { title: "客户", render: (_, r) => (r.customer ? `${r.customer.name} ${r.customer.phoneMasked}` : "-") },
    { title: "卖家", render: (_, r) => r.sellerName ?? "-" },
    { title: "卖家身份证号", render: (_, r) => <SellerId row={r} canReveal={canSeeSellerId} /> },
    { title: "经手人", render: (_, r) => r.handledBy.name },
    { title: "时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
  ];

  return (
    <Card
      title={`回收单（${total}）`}
      extra={
        <Space>
          {canRefurbish ? (
            <Link href="/trade-ins/stock">
              <Button>回收库存 / 转良品</Button>
            </Link>
          ) : null}
          {canCreate ? (
            <Link href="/trade-ins/new">
              <Button type="primary">新建回收单</Button>
            </Link>
          ) : null}
        </Space>
      }
    >
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: true }}
        pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (p) => router.push(`/trade-ins?page=${p}`) }}
      />
    </Card>
  );
}
