"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { App, Button, Card, Descriptions, Input, Popconfirm, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDate, formatDateTime, formatFen } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, SALES_STATUS_COLORS, SALES_STATUS_LABELS } from "@/lib/sales-labels";
import type { SalesOrderDetail } from "@/server/sales/sales-service";
import { voidSalesOrderAction } from "../actions";

type Item = SalesOrderDetail["items"][number];

export function SalesDetailView({ order, canVoid, showCost }: { order: SalesOrderDetail; canVoid: boolean; showCost: boolean }) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");

  const itemColumns: TableColumnsType<Item> = [
    { title: "商品", render: (_, i) => i.sku.name },
    { title: "机器 / 数量", render: (_, i) => (i.device ? <Link href={`/stock/devices/${i.device.code}`}>{i.device.code}</Link> : `× ${i.qty}`) },
    { title: "单价（元）", dataIndex: "unitPriceFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "小计（元）", dataIndex: "lineTotalFen", align: "right", render: (v: number) => formatFen(v) },
    ...(showCost
      ? [
          { title: "成本（元）", dataIndex: "costFen", align: "right" as const, render: (v: number) => formatFen(v) },
          { title: "毛利（元）", align: "right" as const, render: (_: unknown, i: Item) => formatFen(i.lineTotalFen - i.costFen) },
        ]
      : []),
  ];

  const grossFen = order.items.reduce((s, i) => s + i.lineTotalFen - i.costFen, 0) - order.discountFen;

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={
          <Space>
            <span>销售单 {order.orderNo}</span>
            <Tag color={SALES_STATUS_COLORS[order.status]}>{SALES_STATUS_LABELS[order.status]}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Link href="/sales">
              <Button size="small">返回列表</Button>
            </Link>
            <Link href="/sales/new">
              <Button size="small" type="primary">
                再开一单
              </Button>
            </Link>
            {canVoid && order.status === "COMPLETED" && !order.dailyCloseId ? (
              <Popconfirm
                title="作废这张单？机器回在库、配件加回数量，收款作废。"
                description={<Input placeholder="作废原因" value={reason} onChange={(e) => setReason(e.target.value)} />}
                onConfirm={() =>
                  startTransition(async () => {
                    const result = await voidSalesOrderAction(order.id, reason);
                    if (result.ok) message.success("已作废，库存已恢复");
                    else message.error(result.error);
                  })
                }
              >
                <Button size="small" danger loading={pending}>
                  作废
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        }
      >
        <Descriptions
          column={{ xs: 1, md: 3 }}
          items={[
            { key: "store", label: "门店", children: `${order.store.code} ${order.store.name}` },
            { key: "customer", label: "客户", children: order.customer ? `${order.customer.name} ${order.customer.phoneMasked}` : "散客" },
            { key: "sales", label: "销售员", children: order.salesperson.name },
            { key: "date", label: "营业日", children: formatDate(order.bizDate) },
            { key: "created", label: "开单时间", children: formatDateTime(order.createdAt) },
            { key: "total", label: "应收", children: `${formatFen(order.totalFen)} 元（商品 ${formatFen(order.subtotalFen)} − 优惠 ${formatFen(order.discountFen)}）` },
            ...(showCost ? [{ key: "gross", label: "毛利", children: `${formatFen(grossFen)} 元` }] : []),
            { key: "note", label: "备注", children: order.note ?? "-" },
            ...(order.status === "VOIDED"
              ? [{ key: "void", label: "作废", children: `${order.voidedBy?.name ?? ""} · ${order.voidedAt ? formatDateTime(order.voidedAt) : ""}${order.voidReason ? ` · ${order.voidReason}` : ""}`, span: 3 }]
              : []),
          ]}
        />
        <Table rowKey="id" size="small" pagination={false} columns={itemColumns} dataSource={order.items} scroll={{ x: true }} style={{ marginTop: 16 }} />
      </Card>
      <Card title="收款">
        {order.payments.map((p) => (
          <Typography.Paragraph key={p.id} style={{ marginBottom: 4 }}>
            {PAYMENT_METHOD_LABELS[p.method]}：{formatFen(p.amountFen)} 元
            {order.status === "VOIDED" ? <Tag style={{ marginLeft: 8 }}>已作废</Tag> : null}
          </Typography.Paragraph>
        ))}
      </Card>
    </Space>
  );
}
