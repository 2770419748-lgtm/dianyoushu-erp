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

export function SalesDetailView({ order, canVoid, canSell, showCost }: { order: SalesOrderDetail; canVoid: boolean; canSell: boolean; showCost: boolean }) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");

  const itemColumns: TableColumnsType<Item> = [
    {
      title: "商品",
      render: (_, i) =>
        i.entitlement ? (
          <Space orientation="vertical" size={0}>
            <span>
              {i.sku.name} {i.entitlement.status === "VOIDED" ? <Tag>已失效</Tag> : null}
            </span>
            <Typography.Text type="secondary">
              {i.entitlement.device ? `保 ${i.entitlement.device.code}${i.entitlement.deviceReturnedAt ? "（机器已退回）" : ""}，` : ""}到 {formatDate(i.entitlement.expiresOn)} 止
            </Typography.Text>
          </Space>
        ) : (
          i.sku.name
        ),
    },
    { title: "机器 / 数量", render: (_, i) => (i.device ? <Link href={`/stock/devices/${i.device.code}`}>{i.device.code}</Link> : `× ${i.qty}`) },
    {
      title: "单价（元）",
      align: "right",
      render: (_, i) =>
        i.listPriceFen !== null && i.listPriceFen !== i.unitPriceFen ? (
          <Space size={4} orientation="vertical" style={{ alignItems: "flex-end" }}>
            <span>{formatFen(i.unitPriceFen)}</span>
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
              改价，原价 {formatFen(i.listPriceFen)}
            </Tag>
          </Space>
        ) : (
          formatFen(i.unitPriceFen)
        ),
    },
    { title: "小计（元）", dataIndex: "lineTotalFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "已退", dataIndex: "returnedQty", align: "right", render: (v: number) => (v > 0 ? <Tag color="orange">{v}</Tag> : "-") },
    ...(showCost
      ? [
          { title: "成本（元）", dataIndex: "costFen", align: "right" as const, render: (v: number) => formatFen(v) },
          { title: "毛利（元）", align: "right" as const, render: (_: unknown, i: Item) => formatFen(i.lineTotalFen - i.costFen) },
        ]
      : []),
  ];

  // 毛利扣掉退货：应收 − 已退款 − 没退回那部分商品的成本
  const refundedFen = order.returnOrders.reduce((s, r) => s + r.refundFen, 0);
  const keptCostFen = order.items.reduce((s, i) => s + Math.round((i.costFen * (i.qty - i.returnedQty)) / i.qty), 0);
  const grossFen = order.status === "COMPLETED" ? order.totalFen - refundedFen - keptCostFen : 0;
  const canReturn = canSell && order.status === "COMPLETED" && order.items.some((i) => i.returnedQty < i.qty);

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
            {canSell ? (
              <Link href="/sales/new">
                <Button size="small" type="primary">
                  再开一单
                </Button>
              </Link>
            ) : null}
            {canReturn ? (
              order.todayClosed ? (
                <Button size="small" disabled title="这家店今天已经日结确认，要退货请总部先撤销日结">
                  退货（今天已日结）
                </Button>
              ) : (
                <Link href={`/sales/${order.id}/return`}>
                  <Button size="small">退货</Button>
                </Link>
              )
            ) : null}
            {canVoid && order.status === "COMPLETED" && !order.dailyCloseId && order.returnOrders.length === 0 ? (
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
            {
              key: "customer",
              label: "客户",
              // 客户详情只给店员、店长、总部（区域经理不进客户详情）
              children: order.customer ? canSell ? <Link href={`/customers/${order.customer.id}`}>{order.customer.name} {order.customer.phoneMasked}</Link> : `${order.customer.name} ${order.customer.phoneMasked}` : "散客",
            },
            { key: "sales", label: "销售员", children: order.salesperson.name },
            { key: "date", label: "营业日", children: formatDate(order.bizDate) },
            { key: "created", label: "开单时间", children: formatDateTime(order.createdAt) },
            { key: "total", label: "应收", children: `${formatFen(order.totalFen)} 元（商品 ${formatFen(order.subtotalFen)} − 优惠 ${formatFen(order.discountFen)}）` },
            ...(showCost ? [{ key: "gross", label: refundedFen > 0 ? "毛利（已扣退货）" : "毛利", children: `${formatFen(grossFen)} 元` }] : []),
            { key: "note", label: "备注", children: order.note ?? "-" },
            ...(order.status === "VOIDED"
              ? [{ key: "void", label: "作废", children: `${order.voidedBy?.name ?? ""} · ${order.voidedAt ? formatDateTime(order.voidedAt) : ""}${order.voidReason ? ` · ${order.voidReason}` : ""}`, span: "filled" as const }]
              : []),
          ]}
        />
        <Table rowKey="id" size="small" pagination={false} columns={itemColumns} dataSource={order.items} scroll={{ x: true }} style={{ marginTop: 16 }} />
      </Card>
      <Card title="收款">
        {order.payments.map((p) => (
          <Typography.Paragraph key={p.id} style={{ marginBottom: 4 }}>
            {PAYMENT_METHOD_LABELS[p.method]}：{formatFen(p.amountFen)} 元
            {p.method === "TRADE_IN" ? <Typography.Text type="secondary">（回收单 {p.reference ?? order.tradeInOrder?.orderNo ?? ""}）</Typography.Text> : null}
            {order.status === "VOIDED" ? <Tag style={{ marginLeft: 8 }}>已作废</Tag> : null}
          </Typography.Paragraph>
        ))}
        {order.tradeInOrder ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            以旧换新：{order.tradeInOrder.modelName}，旧机 <Link href={`/stock/devices/${order.tradeInOrder.deviceCode}`}>{order.tradeInOrder.deviceCode}</Link>，估价 {formatFen(order.tradeInOrder.appraisedFen)} 元
          </Typography.Paragraph>
        ) : null}
      </Card>
      {order.returnOrders.length > 0 ? (
        <Card title={`退货记录（${order.returnOrders.length}）`}>
          {order.returnOrders.map((r) => (
            <Card key={r.id} size="small" style={{ marginBottom: 8 }} title={`${r.orderNo} · ${formatDateTime(r.createdAt)} · ${r.handledBy.name}`}>
              {r.items.map((i) => (
                <Typography.Paragraph key={i.id} style={{ marginBottom: 4 }}>
                  {i.sku.name} {i.device ? i.device.code : `× ${i.qty}`}
                </Typography.Paragraph>
              ))}
              <Typography.Text>
                退款 {formatFen(r.refundFen)} 元{r.payments[0] ? `（${PAYMENT_METHOD_LABELS[r.payments[0].method]}）` : ""}
                {r.reason ? ` · ${r.reason}` : ""}
              </Typography.Text>
            </Card>
          ))}
        </Card>
      ) : null}
    </Space>
  );
}
