"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { DEVICE_STATUS_LABELS } from "@/lib/stock-labels";
import type { TransferAccessoryOption, TransferDeviceOption } from "@/server/transfer/transfer-service";
import { createTransferAction } from "../actions";

interface FormValues {
  toStoreId: number;
  note?: string;
  accessories: Record<number, number | undefined>;
}

// 新建调拨：在发出店的在库/良品机器里勾选，配件填数量。提交后机器立刻锁定，不能再卖。
export function TransferForm({
  fromStores,
  toStores,
  fromStoreId,
  devices,
  accessories,
}: {
  fromStores: { id: number; label: string }[];
  toStores: { id: number; label: string }[];
  fromStoreId: number;
  devices: TransferDeviceOption[];
  accessories: TransferAccessoryOption[];
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<FormValues>();
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<number[]>([]);
  const [deviceFilter, setDeviceFilter] = useState("");

  const visibleDevices = devices.filter((d) => !deviceFilter || d.imei.includes(deviceFilter) || d.sku.name.toLowerCase().includes(deviceFilter.toLowerCase()));

  const deviceColumns: TableColumnsType<TransferDeviceOption> = [
    { title: "串号", dataIndex: "imei" },
    { title: "商品", render: (_, d) => d.sku.name },
    { title: "状态", dataIndex: "status", render: (s: TransferDeviceOption["status"]) => <Tag>{DEVICE_STATUS_LABELS[s]}</Tag> },
  ];

  const accessoryColumns: TableColumnsType<TransferAccessoryOption> = [
    { title: "配件", render: (_, a) => a.sku.name },
    { title: "现有", dataIndex: "qty", align: "right" },
    {
      title: "调出数量",
      width: 160,
      render: (_, a) => (
        <Form.Item name={["accessories", a.skuId]} style={{ marginBottom: 0 }}>
          <InputNumber min={0} max={a.qty} precision={0} style={{ width: 120 }} placeholder="0" />
        </Form.Item>
      ),
    },
  ];

  function onFinish(values: FormValues) {
    const accessoryLines = Object.entries(values.accessories ?? {})
      .map(([skuId, qty]) => ({ skuId: Number(skuId), qty: qty ?? 0 }))
      .filter((a) => a.qty > 0);
    startTransition(async () => {
      const result = await createTransferAction({ fromStoreId, toStoreId: values.toStoreId, note: values.note, deviceIds: selectedDeviceIds, accessories: accessoryLines });
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success("调拨已申请，机器已锁定");
      router.push(`/transfers/${result.id}`);
    });
  }

  return (
    <Card title="新建调拨">
      <Form<FormValues> form={form} name="transfer" layout="vertical" onFinish={onFinish}>
        <Space size="large" wrap>
          <Form.Item label="发出门店">
            <Select
              value={fromStoreId}
              style={{ width: 240 }}
              showSearch
              optionFilterProp="label"
              options={fromStores.map((s) => ({ value: s.id, label: s.label }))}
              onChange={(value) => router.push(`/transfers/new?fromStoreId=${value}`)}
              disabled={fromStores.length === 1}
            />
          </Form.Item>
          <Form.Item name="toStoreId" label="收货门店" rules={[{ required: true, message: "请选择收货门店" }]}>
            <Select
              style={{ width: 240 }}
              showSearch
              optionFilterProp="label"
              placeholder="选择收货门店"
              options={toStores.filter((s) => s.id !== fromStoreId).map((s) => ({ value: s.id, label: s.label }))}
            />
          </Form.Item>
        </Space>
        <Form.Item name="note" label="备注">
          <Input maxLength={200} />
        </Form.Item>

        <Typography.Title level={5}>机器（勾选要调出的，已选 {selectedDeviceIds.length} 台）</Typography.Title>
        <Input.Search allowClear placeholder="按串号或商品名筛" style={{ width: 280, marginBottom: 8 }} onSearch={setDeviceFilter} onChange={(e) => !e.target.value && setDeviceFilter("")} />
        <Table
          rowKey="id"
          size="small"
          columns={deviceColumns}
          dataSource={visibleDevices}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          rowSelection={{ selectedRowKeys: selectedDeviceIds, onChange: (keys) => setSelectedDeviceIds(keys.map(Number)), preserveSelectedRowKeys: true }}
        />

        <Typography.Title level={5} style={{ marginTop: 16 }}>
          配件（填调出数量）
        </Typography.Title>
        <Table rowKey="skuId" size="small" columns={accessoryColumns} dataSource={accessories} pagination={false} />

        <Space style={{ marginTop: 24 }}>
          <Button type="primary" htmlType="submit" loading={pending}>
            提交申请
          </Button>
          <Button onClick={() => router.push("/transfers")}>取消</Button>
        </Space>
      </Form>
    </Card>
  );
}
