"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, Modal, Select, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime } from "@/lib/format";
import { STOCKTAKE_STATUS_COLORS, STOCKTAKE_STATUS_LABELS } from "@/lib/stock-labels";
import type { StocktakeRow } from "@/server/stocktake/stocktake-service";
import { createStocktakeAction } from "./actions";

export function StocktakeListView({
  rows,
  total,
  page,
  pageSize,
  stores,
  defaultStoreId,
  canCreate,
}: {
  rows: StocktakeRow[];
  total: number;
  page: number;
  pageSize: number;
  stores: { id: number; label: string }[];
  defaultStoreId?: number;
  canCreate: boolean;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ storeId: number; note?: string }>();

  const columns: TableColumnsType<StocktakeRow> = [
    { title: "单号", dataIndex: "stocktakeNo", render: (no: string, r) => <Link href={`/stocktakes/${r.id}`}>{no}</Link> },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "状态", dataIndex: "status", render: (s: StocktakeRow["status"]) => <Tag color={STOCKTAKE_STATUS_COLORS[s]}>{STOCKTAKE_STATUS_LABELS[s]}</Tag> },
    { title: "应有 / 已录", render: (_, r) => `${r.items.length} / ${r.items.filter((i) => i.countedQty !== null).length}` },
    {
      title: "差异",
      render: (_, r) => {
        const diffs = r.items.filter((i) => (i.diffQty ?? 0) !== 0);
        return diffs.length === 0 ? <Tag>无</Tag> : <Tag color="red">{diffs.length} 项</Tag>;
      },
    },
    { title: "发起人", render: (_, r) => r.createdBy.name },
    { title: "发起时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
  ];

  return (
    <Card
      title={`盘点（${total}）`}
      extra={
        canCreate ? (
          <Button
            type="primary"
            onClick={() => {
              form.resetFields();
              if (defaultStoreId) form.setFieldsValue({ storeId: defaultStoreId });
              setOpen(true);
            }}
          >
            发起盘点
          </Button>
        ) : null
      }
    >
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: true }}
        pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (p) => router.push(`/stocktakes?page=${p}`) }}
      />
      <Modal title="发起盘点" open={open} confirmLoading={pending} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden>
        <Form
          form={form}
          name="stocktake"
          layout="vertical"
          onFinish={(values) =>
            startTransition(async () => {
              const result = await createStocktakeAction(values);
              if (!result.ok) {
                message.error(result.error);
                return;
              }
              message.success("已建盘点任务，应有数已快照");
              setOpen(false);
              router.push(`/stocktakes/${result.id}`);
            })
          }
        >
          <Form.Item name="storeId" label="门店" rules={[{ required: true, message: "请选择门店" }]}>
            <Select showSearch optionFilterProp="label" options={stores.map((s) => ({ value: s.id, label: s.label }))} disabled={stores.length === 1} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={200} placeholder="如 月末盘点" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
