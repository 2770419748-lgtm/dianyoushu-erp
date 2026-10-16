"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, InputNumber, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatFen, yuanToFen } from "@/lib/format";
import type { StorePriceRow } from "@/server/products/price-service";
import type { ActionResult } from "@/server/products/action-result";
import { setStorePriceAction } from "./actions";

export function PricesView({
  stores,
  storeId,
  q,
  rows,
  canEdit,
}: {
  stores: { id: number; label: string }[];
  storeId: number;
  q: string;
  rows: StorePriceRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<{ open: boolean; record?: StorePriceRow }>({ open: false });
  const [form] = Form.useForm<{ priceYuan: number }>();

  function navigate(next: { storeId?: number; q?: string }) {
    const sp = new URLSearchParams();
    sp.set("storeId", String(next.storeId ?? storeId));
    const text = next.q ?? q;
    if (text) sp.set("q", text);
    router.push(`/products/prices?${sp}`);
  }

  function submit(run: () => Promise<ActionResult>, onDone?: () => void) {
    startTransition(async () => {
      const result = await run();
      if (result.ok) {
        message.success("已保存");
        onDone?.();
      } else {
        message.error(result.error);
      }
    });
  }

  const columns: TableColumnsType<StorePriceRow> = [
    { title: "商品", dataIndex: "name", fixed: "left" },
    { title: "品牌 / 型号", render: (_, r) => `${r.brandName} ${r.modelName}` },
    { title: "品类", render: (_, r) => <Space size={4}>{r.categoryName}<Tag color={r.kind === "DEVICE" ? "blue" : "default"}>{r.kind === "DEVICE" ? "大件" : "小件"}</Tag></Space> },
    { title: "指导价（元）", dataIndex: "guidePriceFen", align: "right", render: (v: number) => formatFen(v) },
    {
      title: "本店售价（元）",
      dataIndex: "storePriceFen",
      align: "right",
      render: (v: number | null) => (v === null ? <Typography.Text type="secondary">按指导价</Typography.Text> : <Typography.Text strong>{formatFen(v)}</Typography.Text>),
    },
    {
      title: "实际售价（元）",
      dataIndex: "effectivePriceFen",
      align: "right",
      render: (v: number, r) => (
        <Space size={4}>
          {formatFen(v)}
          {r.storePriceFen !== null && r.storePriceFen !== r.guidePriceFen ? (
            <Tag color={r.storePriceFen < r.guidePriceFen ? "orange" : "red"}>{r.storePriceFen < r.guidePriceFen ? "低于指导价" : "高于指导价"}</Tag>
          ) : null}
        </Space>
      ),
    },
  ];
  if (canEdit) {
    columns.push({
      title: "操作",
      render: (_, r) => (
        <Space>
          <Button
            size="small"
            onClick={() => {
              form.setFieldsValue({ priceYuan: r.effectivePriceFen / 100 });
              setModal({ open: true, record: r });
            }}
          >
            改价
          </Button>
          {r.storePriceFen !== null ? (
            <Popconfirm title="恢复按指导价卖？" onConfirm={() => submit(() => setStorePriceAction(storeId, r.id, null))}>
              <Button size="small">恢复指导价</Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    });
  }

  return (
    <Card title="门店售价">
      <Typography.Paragraph type="secondary">
        没设过的商品按指导价卖；在这里设的售价只对这一家店生效。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          value={storeId}
          style={{ width: 220 }}
          showSearch
          optionFilterProp="label"
          options={stores.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(value) => navigate({ storeId: value })}
          disabled={stores.length === 1}
        />
        <Input.Search allowClear placeholder="搜商品名、型号或条码" defaultValue={q} style={{ width: 260 }} onSearch={(value) => navigate({ q: value })} />
      </Space>
      <Table rowKey="id" size="small" columns={columns} dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 20, showSizeChanger: false }} />

      <Modal
        title={`改价：${modal.record?.name ?? ""}`}
        open={modal.open}
        confirmLoading={pending}
        onCancel={() => setModal({ open: false })}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form
          form={form}
          name="price"
          layout="vertical"
          onFinish={(values) =>
            submit(
              () => setStorePriceAction(storeId, modal.record!.id, yuanToFen(values.priceYuan)),
              () => setModal({ open: false }),
            )
          }
        >
          <Form.Item label="指导价（元）">
            <Typography.Text>{modal.record ? formatFen(modal.record.guidePriceFen) : ""}</Typography.Text>
          </Form.Item>
          <Form.Item name="priceYuan" label="本店售价（元）" rules={[{ required: true, message: "请输入售价" }]}>
            <InputNumber min={0} precision={2} style={{ width: 200 }} autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
