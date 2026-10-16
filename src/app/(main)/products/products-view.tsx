"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { formatFen, yuanToFen } from "@/lib/format";
import type { Catalog, SkuRow } from "@/server/products/product-service";
import type { ActionResult } from "@/server/products/action-result";
import { createSkuAction, setSkuActiveAction, updateSkuAction } from "./actions";

interface Query {
  q: string;
  categoryId?: number;
  brandId?: number;
  page: number;
  includeInactive: boolean;
}

type SkuFormValues = {
  modelId: number;
  name: string;
  color?: string;
  storage?: string;
  barcode?: string;
  guidePriceYuan: number;
  costPriceYuan?: number;
};

export function ProductsView({
  rows,
  total,
  page,
  pageSize,
  query,
  catalog,
  canManage,
}: {
  rows: SkuRow[];
  total: number;
  page: number;
  pageSize: number;
  query: Query;
  catalog: Catalog;
  canManage: boolean;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<{ open: boolean; record?: SkuRow }>({ open: false });
  const [form] = Form.useForm<SkuFormValues>();

  function navigate(next: Partial<Query>) {
    const merged = { ...query, ...next };
    const sp = new URLSearchParams();
    if (merged.q) sp.set("q", merged.q);
    if (merged.categoryId) sp.set("categoryId", String(merged.categoryId));
    if (merged.brandId) sp.set("brandId", String(merged.brandId));
    if (merged.page > 1) sp.set("page", String(merged.page));
    if (merged.includeInactive) sp.set("all", "1");
    router.push(`/products${sp.size ? `?${sp}` : ""}`);
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

  function openModal(record?: SkuRow) {
    form.resetFields();
    if (record) {
      form.setFieldsValue({
        modelId: record.modelId,
        name: record.name,
        color: record.color ?? undefined,
        storage: record.storage ?? undefined,
        barcode: record.barcode ?? undefined,
        guidePriceYuan: record.guidePriceFen / 100,
        costPriceYuan: record.costPriceFen / 100,
      });
    }
    setModal({ open: true, record });
  }

  function onFinish(values: SkuFormValues) {
    const input = {
      modelId: values.modelId,
      name: values.name,
      color: values.color,
      storage: values.storage,
      barcode: values.barcode,
      guidePriceFen: yuanToFen(values.guidePriceYuan),
      costPriceFen: yuanToFen(values.costPriceYuan ?? 0),
    };
    submit(
      () => (modal.record ? updateSkuAction(modal.record.id, input) : createSkuAction(input)),
      () => setModal({ open: false }),
    );
  }

  const columns: TableColumnsType<SkuRow> = [
    { title: "商品", dataIndex: "name", fixed: "left" },
    { title: "品牌", render: (_, r) => r.model.brand.name },
    { title: "型号", render: (_, r) => r.model.name },
    {
      title: "品类",
      render: (_, r) => (
        <Space size={4}>
          {r.model.category.name}
          <Tag color={r.model.category.kind === "DEVICE" ? "blue" : "default"}>{r.model.category.kind === "DEVICE" ? "大件" : "小件"}</Tag>
        </Space>
      ),
    },
    { title: "颜色", dataIndex: "color", render: (v: string | null) => v ?? "-" },
    { title: "容量", dataIndex: "storage", render: (v: string | null) => v ?? "-" },
    { title: "条码", dataIndex: "barcode", render: (v: string | null) => v ?? "-" },
    { title: "指导价（元）", dataIndex: "guidePriceFen", align: "right", render: (v: number) => formatFen(v) },
  ];
  if (canManage) {
    columns.push(
      { title: "参考成本（元）", dataIndex: "costPriceFen", align: "right", render: (v: number) => formatFen(v) },
      { title: "状态", dataIndex: "isActive", render: (v: boolean) => (v ? <Tag color="green">在售</Tag> : <Tag>停售</Tag>) },
      {
        title: "操作",
        render: (_, r) => (
          <Space>
            <Button size="small" onClick={() => openModal(r)}>
              编辑
            </Button>
            <Popconfirm title={r.isActive ? "确定停售？库存和历史单据不受影响。" : "确定恢复在售？"} onConfirm={() => submit(() => setSkuActiveAction(r.id, !r.isActive))}>
              <Button size="small" danger={r.isActive}>
                {r.isActive ? "停售" : "恢复"}
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    );
  }

  const modelOptions = catalog.models
    .filter((m) => m.isActive)
    .map((m) => ({ value: m.id, label: `${m.brand.name} ${m.name}（${m.category.name}）` }));

  return (
    <Card
      title={`商品（${total}）`}
      extra={
        canManage ? (
          <Space>
            <Link href="/products/catalog">
              <Button>品类 / 品牌 / 型号</Button>
            </Link>
            <Button type="primary" onClick={() => openModal()}>
              新增商品
            </Button>
          </Space>
        ) : null
      }
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search
          allowClear
          placeholder="搜商品名、型号、品牌或条码，如 Mate"
          defaultValue={query.q}
          style={{ width: 280 }}
          onSearch={(value) => navigate({ q: value, page: 1 })}
        />
        <Select
          allowClear
          placeholder="品类"
          style={{ width: 140 }}
          value={query.categoryId}
          options={catalog.categories.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(value) => navigate({ categoryId: value, page: 1 })}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="品牌"
          style={{ width: 140 }}
          value={query.brandId}
          options={catalog.brands.map((b) => ({ value: b.id, label: b.name }))}
          onChange={(value) => navigate({ brandId: value, page: 1 })}
        />
        {canManage ? (
          <Checkbox checked={query.includeInactive} onChange={(e) => navigate({ includeInactive: e.target.checked, page: 1 })}>
            含停售
          </Checkbox>
        ) : null}
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: true }}
        pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
      />

      <Modal
        title={modal.record ? "编辑商品" : "新增商品"}
        open={modal.open}
        confirmLoading={pending}
        onCancel={() => setModal({ open: false })}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} name="sku" layout="vertical" onFinish={onFinish}>
          <Form.Item name="modelId" label="型号" rules={[{ required: true, message: "请选择型号" }]}>
            <Select showSearch optionFilterProp="label" options={modelOptions} placeholder="先在“品类 / 品牌 / 型号”里建好型号" />
          </Form.Item>
          <Form.Item name="name" label="商品名称" rules={[{ required: true, message: "请输入商品名称" }]}>
            <Input maxLength={80} placeholder="如 Mate 70 12GB+256GB 曜金黑" />
          </Form.Item>
          <Space size="large">
            <Form.Item name="color" label="颜色">
              <Input maxLength={20} />
            </Form.Item>
            <Form.Item name="storage" label="容量">
              <Input maxLength={20} placeholder="如 12GB+256GB" />
            </Form.Item>
          </Space>
          <Form.Item name="barcode" label="条码">
            <Input maxLength={30} placeholder="可空；填了必须唯一" />
          </Form.Item>
          <Space size="large">
            <Form.Item name="guidePriceYuan" label="指导价（元）" rules={[{ required: true, message: "请输入指导价" }]}>
              <InputNumber min={0} precision={2} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="costPriceYuan" label="参考成本（元）">
              <InputNumber min={0} precision={2} style={{ width: 160 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
