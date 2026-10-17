"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Popconfirm, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { DeviceStatus } from "@/generated/prisma/enums";
import { formatDateTime, formatFen } from "@/lib/format";
import { DEVICE_STATUS_COLORS, DEVICE_STATUS_LABELS } from "@/lib/stock-labels";
import type { RecycledDeviceRow } from "@/server/tradein/trade-in-service";
import { refurbishAction } from "../actions";

export function RecycledStockView({ rows, total, page, pageSize, canRefurbish }: { rows: RecycledDeviceRow[]; total: number; page: number; pageSize: number; canRefurbish: boolean }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();

  const columns: TableColumnsType<RecycledDeviceRow> = [
    { title: "主码", dataIndex: "code", render: (code: string) => <Link href={`/stock/devices/${code}`}>{code}</Link> },
    { title: "旧机", render: (_, d) => d.tradeInOrder?.modelName ?? d.sku.name },
    { title: "成色", dataIndex: "condition", render: (v: string | null) => v ?? "-" },
    { title: "估价 / 成本（元）", dataIndex: "costFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "门店", render: (_, d) => `${d.store.code} ${d.store.name}` },
    { title: "回收单", render: (_, d) => d.tradeInOrder?.orderNo ?? "-" },
    { title: "回收时间", render: (_, d) => (d.tradeInOrder ? formatDateTime(d.tradeInOrder.createdAt) : "-") },
    { title: "状态", dataIndex: "status", render: (s: DeviceStatus) => <Tag color={DEVICE_STATUS_COLORS[s]}>{DEVICE_STATUS_LABELS[s]}</Tag> },
    {
      title: "操作",
      render: (_, d) =>
        canRefurbish && d.status === "RECYCLED" ? (
          <Popconfirm
            title="检测合格，转成良品？转后可以开单卖。"
            onConfirm={() =>
              startTransition(async () => {
                const result = await refurbishAction(d.id);
                if (result.ok) message.success("已转良品");
                else message.error(result.error);
              })
            }
          >
            <Button size="small" type="primary" loading={pending}>
              转良品
            </Button>
          </Popconfirm>
        ) : d.status === "REFURBISHED" ? (
          <Typography.Text type="secondary">可开单</Typography.Text>
        ) : null,
    },
  ];

  return (
    <Card title={`回收库存（${total}）`} extra={<Link href="/trade-ins"><Button>回收单列表</Button></Link>}>
      <Typography.Paragraph type="secondary">回收机先检测，合格的转良品后就能像新机一样开单卖，卖出毛利 = 售价 − 估价。</Typography.Paragraph>
      <Table rowKey="id" size="small" columns={columns} dataSource={rows} scroll={{ x: true }} pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (p) => router.push(`/trade-ins/stock?page=${p}`) }} />
    </Card>
  );
}
