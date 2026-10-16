"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { App, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime, formatFen } from "@/lib/format";
import { PURCHASE_STATUS_COLORS, PURCHASE_STATUS_LABELS } from "@/lib/stock-labels";
import { parseImeiList } from "@/server/stock/imei";
import type { PurchaseOrderDetail } from "@/server/purchase/purchase-service";
import { receiveGoodsAction, submitPurchaseOrderAction, voidPurchaseOrderAction, type PurchaseActionResult } from "../actions";

type Item = PurchaseOrderDetail["items"][number];

export function PurchaseDetailView({ order, canManage }: { order: PurchaseOrderDetail; canManage: boolean }) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [voidReason, setVoidReason] = useState("");
  const [receiveForm] = Form.useForm<{ lines: Record<number, { imeiText?: string; qty?: number }> }>();
  const lines = Form.useWatch("lines", receiveForm) ?? {};

  const totalFen = order.items.reduce((s, i) => s + i.qty * i.unitCostFen, 0);
  const pendingItems = useMemo(() => order.items.filter((i) => i.receivedQty < i.qty), [order.items]);

  function run(fn: () => Promise<PurchaseActionResult>, success = "已完成") {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) message.success(success);
      else message.error(result.error);
    });
  }

  const itemColumns: TableColumnsType<Item> = [
    { title: "商品", render: (_, i) => i.sku.name },
    { title: "品牌 / 型号", render: (_, i) => `${i.sku.model.brand.name} ${i.sku.model.name}` },
    { title: "类型", render: (_, i) => <Tag color={i.sku.model.category.kind === "DEVICE" ? "blue" : "default"}>{i.sku.model.category.kind === "DEVICE" ? "大件" : "小件"}</Tag> },
    { title: "应到", dataIndex: "qty", align: "right" },
    { title: "已到", dataIndex: "receivedQty", align: "right", render: (v: number, i) => (v >= i.qty ? <Tag color="green">{v}</Tag> : v) },
    { title: "成本单价（元）", dataIndex: "unitCostFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "小计（元）", align: "right", render: (_, i) => formatFen(i.qty * i.unitCostFen) },
  ];

  function onReceive(values: { lines: Record<number, { imeiText?: string; qty?: number }> }) {
    const input = {
      purchaseOrderId: order.id,
      lines: pendingItems.map((item) => ({ itemId: item.id, imeiText: values.lines?.[item.id]?.imeiText, qty: values.lines?.[item.id]?.qty })),
    };
    startTransition(async () => {
      const result = await receiveGoodsAction(input);
      if (result.ok) {
        message.success("入库完成");
        receiveForm.resetFields();
      } else {
        message.error(result.error);
      }
    });
  }

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={
          <Space>
            <span>采购单 {order.orderNo}</span>
            <Tag color={PURCHASE_STATUS_COLORS[order.status]}>{PURCHASE_STATUS_LABELS[order.status]}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Link href="/purchase">
              <Button size="small">返回列表</Button>
            </Link>
            {canManage && order.status === "DRAFT" ? (
              <>
                <Link href={`/purchase/${order.id}/edit`}>
                  <Button size="small">编辑</Button>
                </Link>
                <Popconfirm title="提交后不能再改明细，确定提交？" onConfirm={() => run(() => submitPurchaseOrderAction(order.id), "已提交，可以到货入库了")}>
                  <Button size="small" type="primary" loading={pending}>
                    提交
                  </Button>
                </Popconfirm>
              </>
            ) : null}
            {canManage && (order.status === "DRAFT" || order.status === "SUBMITTED") && order.receipts.length === 0 ? (
              <Popconfirm
                title="作废这张采购单？"
                description={<Input placeholder="作废原因（可不填）" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />}
                onConfirm={() => run(() => voidPurchaseOrderAction(order.id, voidReason), "已作废")}
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
            { key: "store", label: "收货门店", children: `${order.store.code} ${order.store.name}` },
            { key: "supplier", label: "供应商", children: order.supplierName ?? "-" },
            { key: "total", label: "合计金额", children: `${formatFen(totalFen)} 元` },
            { key: "creator", label: "创建人", children: order.createdBy.name },
            { key: "created", label: "创建时间", children: formatDateTime(order.createdAt) },
            { key: "received", label: "到货时间", children: order.receivedAt ? formatDateTime(order.receivedAt) : "-" },
            { key: "note", label: "备注", children: order.note ?? "-", span: 3 },
          ]}
        />
        <Table rowKey="id" size="small" pagination={false} columns={itemColumns} dataSource={order.items} scroll={{ x: true }} style={{ marginTop: 16 }} />
      </Card>

      {canManage && order.status === "SUBMITTED" && pendingItems.length > 0 ? (
        <Card title="到货入库">
          <Typography.Paragraph type="secondary">
            大件：把串号粘贴进去，一行一个或用空格、逗号隔开，15 位数字；小件：填本次到货数量。可以分多次到货，全部到齐采购单自动变“已到货”。
          </Typography.Paragraph>
          <Form form={receiveForm} name="receive" layout="vertical" onFinish={onReceive}>
            {pendingItems.map((item) => {
              const remaining = item.qty - item.receivedQty;
              const isDevice = item.sku.model.category.kind === "DEVICE";
              const parsed = isDevice ? parseImeiList(lines[item.id]?.imeiText ?? "") : null;
              return (
                <Card key={item.id} size="small" style={{ marginBottom: 12 }} title={`${item.sku.name}（还差 ${remaining} ${isDevice ? "台" : "件"}）`}>
                  {isDevice ? (
                    <>
                      <Form.Item name={["lines", item.id, "imeiText"]} style={{ marginBottom: 4 }}>
                        <Input.TextArea rows={4} placeholder={"粘贴串号，例如：\n867530012345678\n867530012345679"} />
                      </Form.Item>
                      <Typography.Text type={parsed && (parsed.invalid.length || parsed.duplicates.length || parsed.valid.length > remaining) ? "danger" : "secondary"}>
                        已识别 {parsed?.valid.length ?? 0} 个
                        {parsed && parsed.invalid.length > 0 ? `，${parsed.invalid.length} 个格式不对` : ""}
                        {parsed && parsed.duplicates.length > 0 ? `，${parsed.duplicates.length} 个重复` : ""}
                        {parsed && parsed.valid.length > remaining ? `，超过还差的 ${remaining} 台` : ""}
                      </Typography.Text>
                    </>
                  ) : (
                    <Form.Item name={["lines", item.id, "qty"]} label="本次到货数量" style={{ marginBottom: 0 }}>
                      <InputNumber min={0} max={remaining} precision={0} style={{ width: 160 }} />
                    </Form.Item>
                  )}
                </Card>
              );
            })}
            <Button type="primary" htmlType="submit" loading={pending}>
              确认入库
            </Button>
          </Form>
        </Card>
      ) : null}

      {order.receipts.length > 0 ? (
        <Card title={`到货记录（${order.receipts.length}）`}>
          {order.receipts.map((receipt) => (
            <Card key={receipt.id} size="small" style={{ marginBottom: 12 }} title={`${receipt.receiptNo} · ${formatDateTime(receipt.createdAt)} · ${receipt.receivedBy.name}`}>
              {receipt.items.map((line) => {
                const imeis = receipt.devices.filter((d) => d.skuId === line.skuId).map((d) => d.imei);
                return (
                  <div key={line.id} style={{ marginBottom: 8 }}>
                    <Typography.Text strong>{line.sku.name}</Typography.Text> × {line.qty}
                    {imeis.length > 0 ? (
                      <div style={{ marginTop: 4 }}>
                        {imeis.map((imei) => (
                          <Tag key={imei} style={{ marginBottom: 4 }}>
                            <Link href={`/stock/devices/${imei}`}>{imei}</Link>
                          </Tag>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {receipt.note ? <Typography.Text type="secondary">备注：{receipt.note}</Typography.Text> : null}
            </Card>
          ))}
        </Card>
      ) : null}
    </Space>
  );
}
