"use client";

import { useTransition } from "react";
import Link from "next/link";
import { App, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime } from "@/lib/format";
import { DEVICE_STATUS_COLORS, DEVICE_STATUS_LABELS, TRANSFER_STATUS_COLORS, TRANSFER_STATUS_LABELS } from "@/lib/stock-labels";
import { parseImeiList } from "@/server/stock/imei";
import type { TransferDetail } from "@/server/transfer/transfer-service";
import { receiveTransferAction, shipTransferAction, voidTransferAction, type TransferActionResult } from "../actions";

type Item = TransferDetail["items"][number];

export function TransferDetailView({ order, canManage }: { order: TransferDetail; canManage: boolean }) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<{ imeiText?: string; lines: Record<number, number | undefined> }>();
  const imeiText = Form.useWatch("imeiText", form) ?? "";

  const deviceItems = order.items.filter((i) => i.deviceId);
  const accessoryItems = order.items.filter((i) => !i.deviceId);
  const pendingDevices = deviceItems.filter((i) => i.receivedQty < i.qty);
  const pendingAccessories = accessoryItems.filter((i) => i.receivedQty < i.qty);
  const parsed = parseImeiList(imeiText);
  const pendingImeis = new Set(pendingDevices.map((i) => i.device!.imei));
  const unknown = parsed.valid.filter((imei) => !pendingImeis.has(imei));

  function run(fn: () => Promise<TransferActionResult>, success: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        message.success(success);
        form.resetFields();
      } else {
        message.error(result.error);
      }
    });
  }

  const deviceColumns: TableColumnsType<Item> = [
    { title: "串号", render: (_, i) => <Link href={`/stock/devices/${i.device!.imei}`}>{i.device!.imei}</Link> },
    { title: "商品", render: (_, i) => i.sku.name },
    { title: "机器状态", render: (_, i) => <Tag color={DEVICE_STATUS_COLORS[i.device!.status]}>{DEVICE_STATUS_LABELS[i.device!.status]}</Tag> },
    { title: "收货", render: (_, i) => (i.receivedQty >= i.qty ? <Tag color="green">已收{i.receivedAt ? ` ${formatDateTime(i.receivedAt)}` : ""}</Tag> : <Tag>未收</Tag>) },
  ];

  const accessoryColumns: TableColumnsType<Item> = [
    { title: "配件", render: (_, i) => i.sku.name },
    { title: "应收", dataIndex: "qty", align: "right" },
    { title: "已收", dataIndex: "receivedQty", align: "right", render: (v: number, i) => (v >= i.qty ? <Tag color="green">{v}</Tag> : v) },
  ];

  const showShip = canManage && order.status === "REQUESTED" && order.canFrom;
  const showVoid = canManage && order.status === "REQUESTED" && order.canFrom;
  const showReceive = canManage && order.status === "SHIPPED" && order.canTo;

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={
          <Space>
            <span>调拨单 {order.orderNo}</span>
            <Tag color={TRANSFER_STATUS_COLORS[order.status]}>{TRANSFER_STATUS_LABELS[order.status]}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Link href="/transfers">
              <Button size="small">返回列表</Button>
            </Link>
            {showShip ? (
              <Popconfirm title="确认发出？发出后机器变在途，发出店库存减少。" onConfirm={() => run(() => shipTransferAction(order.id), "已发出")}>
                <Button size="small" type="primary" loading={pending}>
                  发出
                </Button>
              </Popconfirm>
            ) : null}
            {showVoid ? (
              <Popconfirm title="作废这张调拨单？机器会解锁回在库。" onConfirm={() => run(() => voidTransferAction(order.id), "已作废")}>
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
            { key: "from", label: "发出店", children: `${order.fromStore.code} ${order.fromStore.name}` },
            { key: "to", label: "收货店", children: `${order.toStore.code} ${order.toStore.name}` },
            { key: "req", label: "申请", children: `${order.requestedBy.name} · ${formatDateTime(order.requestedAt)}` },
            { key: "ship", label: "发出", children: order.shippedAt ? `${order.shippedBy?.name ?? ""} · ${formatDateTime(order.shippedAt)}` : "-" },
            { key: "recv", label: "收货", children: order.receivedAt ? `${order.receivedBy?.name ?? ""} · ${formatDateTime(order.receivedAt)}` : "-" },
            { key: "note", label: "备注", children: order.note ?? "-" },
          ]}
        />
        {deviceItems.length > 0 ? (
          <>
            <Typography.Title level={5} style={{ marginTop: 16 }}>
              机器（{deviceItems.length} 台）
            </Typography.Title>
            <Table rowKey="id" size="small" pagination={false} columns={deviceColumns} dataSource={deviceItems} scroll={{ x: true }} />
          </>
        ) : null}
        {accessoryItems.length > 0 ? (
          <>
            <Typography.Title level={5} style={{ marginTop: 16 }}>
              配件
            </Typography.Title>
            <Table rowKey="id" size="small" pagination={false} columns={accessoryColumns} dataSource={accessoryItems} />
          </>
        ) : null}
      </Card>

      {showReceive ? (
        <Card title="收货核对">
          <Typography.Paragraph type="secondary">把实际收到的机器串号粘贴进去（可以只收一部分，没收到的留在在途）；配件填本次收到的数量。</Typography.Paragraph>
          <Form
            form={form}
            name="receive-transfer"
            layout="vertical"
            onFinish={(values) =>
              run(
                () =>
                  receiveTransferAction(order.id, {
                    imeiText: values.imeiText,
                    accessoryLines: pendingAccessories.map((i) => ({ itemId: i.id, qty: values.lines?.[i.id] ?? 0 })),
                  }),
                "收货完成",
              )
            }
          >
            {pendingDevices.length > 0 ? (
              <>
                <Form.Item name="imeiText" label={`收到的串号（待收 ${pendingDevices.length} 台）`} style={{ marginBottom: 4 }}>
                  <Input.TextArea rows={4} placeholder="粘贴串号，一行一个" />
                </Form.Item>
                <Typography.Text type={unknown.length || parsed.invalid.length ? "danger" : "secondary"} style={{ display: "block", marginBottom: 12 }}>
                  已识别 {parsed.valid.length} 个{parsed.invalid.length ? `，${parsed.invalid.length} 个格式不对` : ""}
                  {unknown.length ? `，${unknown.length} 个不在待收清单里：${unknown.slice(0, 3).join("、")}` : ""}
                </Typography.Text>
              </>
            ) : null}
            {pendingAccessories.map((item) => (
              <Form.Item key={item.id} name={["lines", item.id]} label={`${item.sku.name}（待收 ${item.qty - item.receivedQty} 件）`}>
                <InputNumber min={0} max={item.qty - item.receivedQty} precision={0} style={{ width: 160 }} />
              </Form.Item>
            ))}
            <Button type="primary" htmlType="submit" loading={pending}>
              确认收货
            </Button>
          </Form>
        </Card>
      ) : null}
    </Space>
  );
}
