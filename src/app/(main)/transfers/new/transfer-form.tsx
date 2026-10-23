"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { DEVICE_STATUS_LABELS } from "@/lib/stock-labels";
import type { TransferAccessoryOption, TransferDeviceOption, TransferDevicePage } from "@/server/transfer/transfer-service";
import { createTransferAction, listTransferDevicesAction } from "../actions";

interface FormValues {
  toStoreId: number;
  note?: string;
  accessories: Record<number, number | undefined>;
}

// 新建调拨：在发出店的在库机器里勾选（服务端按码或商品名搜、分页，翻页和换搜索词时已勾的保留），配件填数量。提交后机器立刻锁定，不能再卖。
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
  devices: TransferDevicePage;
  accessories: TransferAccessoryOption[];
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<FormValues>();
  const [devicePage, setDevicePage] = useState<TransferDevicePage>(devices);
  const [deviceQuery, setDeviceQuery] = useState("");
  const [loadingDevices, setLoadingDevices] = useState(false);
  // 已勾选的机器按 id 记下整行，换页、换搜索词后还能显示和提交
  const [selected, setSelected] = useState<Map<number, TransferDeviceOption>>(new Map());
  const selectedDeviceIds = [...selected.keys()];

  async function loadDevices(q: string, page: number) {
    setLoadingDevices(true);
    try {
      setDevicePage(await listTransferDevicesAction(fromStoreId, q, page));
      setDeviceQuery(q);
    } finally {
      setLoadingDevices(false);
    }
  }

  function toggleRows(rows: TransferDeviceOption[], checked: boolean) {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (checked) next.set(r.id, r);
        else next.delete(r.id);
      }
      return next;
    });
  }

  const deviceColumns: TableColumnsType<TransferDeviceOption> = [
    { title: "主码", dataIndex: "code" },
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
        if (result.approval) {
          message.info(result.error, 6);
          router.push(`/approvals/${result.approval.id}`);
          return;
        }
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
        <Input.Search
          allowClear
          placeholder="按 SN、IMEI 或商品名搜"
          style={{ width: 280, marginBottom: 8 }}
          loading={loadingDevices}
          onSearch={(q) => void loadDevices(q.trim(), 1)}
          // 搜索框在整张调拨表单里面，浏览器默认“回车 = 提交表单”，这里拦掉，回车只搜索
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
        {selected.size > 0 ? (
          <div style={{ marginBottom: 8 }}>
            {[...selected.values()].map((d) => (
              <Tag key={d.id} closable onClose={() => toggleRows([d], false)} style={{ marginBottom: 4 }}>
                {d.code} {d.sku.name}
              </Tag>
            ))}
          </div>
        ) : null}
        <Table
          rowKey="id"
          size="small"
          columns={deviceColumns}
          dataSource={devicePage.rows}
          loading={loadingDevices}
          scroll={{ x: true }} // 手机上表格自己横着滚，不把整页撑宽（复查第 82 条）
          pagination={{
            current: devicePage.page,
            pageSize: devicePage.pageSize,
            total: devicePage.total,
            showSizeChanger: false,
            showTotal: (t) => `在库 ${t} 台`,
            onChange: (p) => void loadDevices(deviceQuery, p),
          }}
          rowSelection={{
            selectedRowKeys: selectedDeviceIds,
            onSelect: (row, checked) => toggleRows([row], checked),
            onSelectAll: (checked, _rows, changeRows) => toggleRows(changeRows, checked),
          }}
        />

        <Typography.Title level={5} style={{ marginTop: 16 }}>
          配件（填调出数量）
        </Typography.Title>
        <Table rowKey="skuId" size="small" columns={accessoryColumns} dataSource={accessories} pagination={false} scroll={{ x: true }} />

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
